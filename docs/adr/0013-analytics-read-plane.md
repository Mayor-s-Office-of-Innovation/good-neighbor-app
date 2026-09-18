# ADR 0013: Analytics read plane — S3 export lake with DuckDB over Parquet

## Status

Accepted (2026-09-16). Supersedes the Tier-2 read-plane **tooling** sketched in
[dynamodb-data-model.md](../dynamodb-data-model.md) (Glue catalog → Athena): the lake is
kept, the query engine is DuckDB. The CQRS split itself stands ([ADR 0002](0002-datastore-dynamodb.md)).

## Context

A citywide dashboard is coming, and it needs cross-site OLAP reports (rankings, group-bys,
time series) the operational single table can't serve without scans. The CQRS read plane
(ADR 0002, data-model doc) reserves a Tier-2 lake fed by scheduled DynamoDB PITR exports
(PITR is already on — `infra/modules/app/main.tf`). The earlier sketch: 6-hour export →
Glue catalog → Athena SQL.

Facts that shaped the choice:

- Volume is small and slow-growing (1,200 checks/day ⇒ low single-digit GB of Parquet/year).
- The workload is **not append-only**: check headers are updated (severity/scorecard
  synthesis at `complete`, AP8), tasks transition status, conditions get answered, guidance
  lineage advances. Incremental exports therefore re-emit the same keys across windows.
- No near-real-time need (already settled in the data-model doc). Glue + Athena add catalog
  and per-query-scan ops surface before the dashboard even exists.
- Existing stack is Node/JS on Lambda ([ADR 0004](0004-javascript-with-jsdoc.md)); DuckDB has
  a first-party Node binding (`@duckdb/node-api`) and reads S3 Parquet directly, so the same
  SQL runs in a Lambda and on a laptop.

## Decision

1. **Lake:** scheduled incremental PITR exports every 6 hours (`ExportType:
   INCREMENTAL_EXPORT`, `ExportViewType: NEW_IMAGE_ONLY`) to `s3://<lake>/raw/` (30-day
   lifecycle). The watermark is the previous run's `ExportToTime`, persisted — never
   clock-derived. `ExportToTime` trails current time by ≥ 15 min (DynamoDB limit) plus margin.
2. **Convert:** S3-event-triggered Lambda (`manifest-summary.json` under `raw/`) unmarshals
   DynamoDB JSON and writes **entity-split, Hive-partitioned
   Parquet** (`checks/date=…/`, `tasks/date=…/`, `conditions/date=…/`, …; ZSTD). The
   partition column is the item's own event date (`startedAt` / `createdAt` /
   `reportedAt`), so late-arriving exports land in the correct partition. Every row carries
   the full item as a JSON column plus an `exported_at` stamp; promoted top-level columns
   (`siteId`, `status`, `grade`, `issueCount`, `maxSeverity`, …) follow the metric
   definitions in [dynamodb-data-model.md](../dynamodb-data-model.md). Output file names
   include the export ID, so re-running a conversion overwrites rather than duplicates.
3. **Query engine: DuckDB in-process** (`@duckdb/node-api`), reading the Parquet lake over
   S3 with `hive_partitioning`. A scheduled report Lambda materializes known reports to
   `reports/<name>/<date>.csv|json`; ad-hoc/development SQL runs locally against the same
   files with the same engine.
4. **Latest-wins dedupe in the view from day one:**
   `QUALIFY row_number() OVER (PARTITION BY pk, sk ORDER BY exported_at DESC) = 1`.
   Mutations are real, so this is not a deferred optimization. Compaction is added only if
   this becomes measurably slow (years away at this volume).
5. **Athena stays a future option, not a build:** pointing a Glue catalog/Athena at the same
   Parquet changes nothing upstream, so a shared SQL console for non-engineers can be added
   later without reworking this pipeline.
6. **`grade_score`:** Excellent=5, Good=4, Fair=3, Poor=2, Very Poor=1; null when absent
   (never 0). SQL mirrors the scoring convention rather than storing a baked score.
7. **`@aws-sdk/util-dynamodb` for unmarshalling (native JS insufficient).** The export's
   DynamoDB-JSON encoding is a typed-attribute format (`{"S": …}`, `{"N": "72"}`, `{"M": …}`,
   `{"L": [… ]}`, `{"NULL": true}`) with edge cases that are easy to get subtly wrong in
   hand-rolled parsing — big-number precision, set types, binary base64. It is already in the
   dependency tree (transitive via `@aws-sdk/lib-dynamodb`) and is the SDK's canonical decoder,
   so a hand-written recursive parser would add maintenance risk for zero dependency savings.

## Alternatives weighed

- **Glue catalog + Athena** (the earlier sketch): no converter to maintain, but
  pay-per-scan pricing, a catalog/schema to keep registered, and console ergonomics nobody
  needs yet. Revisit only if non-engineers need shared SQL.
- **Full snapshot exports every 6h:** removes the watermark and dedupe entirely, but costs
  O(whole-table) export + conversion forever and rewrites every partition each run.
  Incremental + view-level dedupe stays cents at this volume.
- **Streams → Firehose → Parquet:** near-real-time; already rejected in the data-model doc
  as overkill for leadership reporting.
- **Streams → Tier-1 counter items:** still the settled design for live KPI reads
  (data-model doc); a separate post-MVP buildout, untouched by this ADR.

## Consequences

- Convert and report Lambdas run DuckDB native binaries → **container-image or Lambda-layer
  packaging** with the same class of deploy-runner concerns as the sharp worker build
  ([ADR 0012](0012-sharp-downscale.md)); the build must fetch linux binaries at `npm ci`
  time. Memory 1–2 GB; the one-time backfill may need chunking.
- **Deletes are invisible to `NEW_IMAGE_ONLY`.** Reporting entities are never hard-deleted
  today (provider deactivation removes only `PROVIDER_SEARCH#` rows); if TTL or delete flows
  ever touch `CHECK#`/`TASK#`/`ASSESSMENT#` items, switch to `NEW_AND_OLD_IMAGES` and write
  tombstones, or add compaction.
- If the export schedule ever falls more than the PITR window (35 days) behind, the
  watermark is unrecoverable — recovery is a fresh full export. Alarm on "no new partition
  in 36h" plus convert/report Lambda errors.
- Raw exports retained 30 days are the re-conversion path for schema changes; older history
  keeps the raw JSON column per row and can be re-derived only from new exports.
- **Dashboard serving** (an API route running DuckDB on demand vs. a frontend reading
  materialized `reports/` output) is decided when the dashboard is built; the lake + SQL is
  the substrate either way.