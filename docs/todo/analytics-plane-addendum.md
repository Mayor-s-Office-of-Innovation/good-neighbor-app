# Addendum: Analytics Plane — Build, Complexity & Cost

*DynamoDB planning set (doc 3 of 5) · [index](../README.md) · ← [data model](../dynamodb-data-model.md) · next → [local-dev plan](../archive/local-dev-environment-plan.md)*

**Status:** Draft for review + prototype build guide
**Date:** 2026-08-12
**Companion to:** [dynamodb-data-model.md](../dynamodb-data-model.md) → *City-wide reporting &
analytics*. That section defines *what* the read plane is; this addendum covers *how complex
it is to build, how you use it, and what it costs* — and the order to build it in for the
prototype.

## Tier 1 — incremental aggregates (computed on write, never on read)

The important mental model: Tier 1 stats are **not computed when a report is read**. They are
maintained incrementally as each check arrives, so reads are always instant.

**Flow:** a check/analysis lands → DynamoDB Streams fires → a small aggregator Lambda does a
one-line atomic counter bump. Reading a report just fetches the already-summed numbers.

```
new check  ──Streams──▶  aggregator Lambda  ──UpdateItem ADD──▶  counter items
                                                                      │
                              report read  ◀──── single Query (pre-summed) ┘
```

**Counter item design** — **daily grain** (one shared partition per day so all sites rank in
one query). Daily is deliberate: the legal 3×/day duty with no grace is a per-day question, so
the day is the atomic counter; longer windows roll up a date range. Counters hold **raw
components, never a finished score** — cleanliness/compliance are computed at read by the
shared scoring module (see the [data model](../dynamodb-data-model.md) *Metric definitions*).

| `pk` | `sk` | Attributes (raw components) |
|---|---|---|
| `STATS#<yyyy-mm-dd>` | `SITE#<siteId>` | checksCompleted, severitySum, issueCount, hazardCount |

- **Rank all ~400 sites for a day** (best/worst): one `Query pk = STATS#2026-08-12`, sort ~400
  tiny rows in memory. No scan, no GSI needed.
- **A month/quarter view:** roll up the daily items across the date range.
- **One site's day:** `GetItem`.

**The correctness gotcha:** Streams can deliver an event twice and `ADD` is not idempotent, so
the Lambda guards each event (e.g. conditional marker per `checkId`) to avoid double-counting.

**Complexity: low.** One Lambda much like the existing `process-submission` worker, Streams
enabled (a flag), and counter items. The pattern is already in the repo.

## Tier 2 — the SQL query lake (two builds)

Tier 2 answers open-ended questions ("any set of sites, any time window"). There are two
builds; **start with the simpler one.**

### T2a — Scheduled DynamoDB → S3 Export → Athena  *(recommended start)*

Native DynamoDB "Export to S3" — no stream processing, almost no code. A scheduled job exports
the table (full or incremental) to S3; Athena queries it with SQL.

- **Latency:** batch. **Incremental export every 6 hours** (settled) — city reports aren't
  real-time, and Tier-1 counters cover live KPIs.
- **Requires** point-in-time recovery (PITR) on the table — which we want for backups anyway.
- **Complexity: low-moderate**, mostly Terraform wiring.

### T2b — Streaming: Streams → Firehose → S3 (Parquet) → Athena  *(graduate later)*

Fresher data (minutes) at the cost of a Firehose stream, Parquet conversion, and a Glue schema
that must evolve with the item shape.

- **Complexity: moderate.** Only worth it if near-real-time dashboards become a requirement —
  they almost certainly won't for leadership reporting.

### What using it feels like (Athena SQL for the three questions)

```sql
-- Best / worst cleanliness this quarter
SELECT site_id, sum(severity_sum) * 1.0 / sum(checks_completed) AS score
FROM checks
WHERE day BETWEEN date '2026-07-01' AND date '2026-09-30'
GROUP BY site_id
ORDER BY score ASC;           -- lowest = cleanest

-- Which sites check regularly (completed vs 3/day expected)
SELECT site_id, count(*) AS done, count(*) * 1.0 / (90 * 3) AS adherence
FROM checks
WHERE day BETWEEN date '2026-07-01' AND date '2026-09-30'
GROUP BY site_id
ORDER BY adherence ASC;       -- lowest = worst compliance

-- Trend over time for a SET of sites (or drop the IN filter for all-sites aggregate)
SELECT date_trunc('month', day) AS month, avg(severity_sum) AS avg_severity
FROM checks
WHERE site_id IN ('site-12','site-88','site-203')
GROUP BY 1 ORDER BY 1;
```

The third query is why Tier 2 exists: arbitrary site-sets and grains that fixed rollups can't
flex to.

## Complexity summary

| Piece | Tier | Build complexity | Notes |
|---|---|---|---|
| DynamoDB Streams | 1 | trivial | config flag |
| Aggregator Lambda | 1 | low | like `process-submission` |
| Counter items | 1 | trivial | `STATS#<period>/SITE#<id>` |
| DynamoDB S3 Export | 2a | low | native, scheduled; needs PITR |
| S3 analytics bucket | 2 | trivial | reuse existing S3+KMS patterns |
| Glue catalog table | 2 | low | schema for Athena |
| Athena workgroup | 2 | low | + results bucket |
| Firehose + Parquet | 2b | moderate | only if we graduate |
| QuickSight | 2 | manual-ish | optional; resists IaC |

## Cost (rough monthly estimates — ballpark, not a quote)

At ~1,200 checks/day and low-single-digit-millions of rows/year. Actuals depend on region and
query volume.

| Component | Estimate | Why |
|---|---|---|
| DynamoDB operational (on-demand R/W + storage) | ~$2–5 | ~300k writes/mo ≈ $0.40; a few GB stored |
| Streams + aggregator Lambda | < $1 | a few thousand invocations/day |
| S3 export + storage | ~$1–5 | a few GB/day at $0.10/GB export |
| Athena | ~$1–5 | $5/TB scanned; queries scan MB–low GB |
| Glue catalog | ~$0 | free under 1M objects |
| **Subtotal (no dashboards)** | **~$5–15** | cheap because the data is small |
| QuickSight (optional) | +$10–40 | ~$5–18/user; dominates the bill if used |

**Takeaway:** without QuickSight the whole operational + analytics stack is plausibly
**$5–15/month**. The cost driver is the dashboard tool, not the data. An always-on RDS
Postgres instance alone would typically exceed this entire stack.

## Prototype build order (T2a)

Goal: experience the scheduled-export → SQL-query loop for real.

1. **Enable PITR + Streams** on the table (Terraform flags).
2. **Aggregator Lambda + counter items** (Tier 1) — reuses the worker pattern; gives instant
   KPI reads immediately.
3. **S3 analytics bucket** (KMS, lifecycle) + a scheduled **incremental DynamoDB S3 Export**
   (EventBridge, every 6 hours).
4. **Glue table** describing the export schema; **Athena workgroup** + results bucket.
5. **Run the three queries above** in the Athena console to feel the query experience.
6. *(Optional)* QuickSight, or render charts in the app via the Athena API — decide after
   step 5.

### Where this can and can't be exercised locally

This is the one part that **does not fit the Docker-free local harness**: DynamoDB S3 Export,
Glue, and Athena are cloud-only (LocalStack Pro emulates some, but not for free). So:

- **Locally:** prototype the **Tier 1 aggregator + counter items** against DynamoDB Local —
  that loop is fully local.
- **To feel Tier 2 (export → Athena):** deploy to the **cloud dev account via Terraform in
  CI**, per the [local-dev plan](../archive/local-dev-environment-plan.md)'s local/cloud split. This is
  exactly the kind of infra-wiring validation that plan says belongs in the cloud env, not
  local.

## Open decisions

1. **Metric formulas** — ✅ **settled 2026-08-12.** Cleanliness = unweighted average severity
   per check (`sum(severitySum)/sum(checksCompleted)`); compliance = compliant-days ÷ total
   days, where a day is compliant iff ≥ 3 checks (legal 3×/day, no grace). Computed at read via
   the shared scoring module; the SQL above mirrors it. See the [data model](../dynamodb-data-model.md)
   *Metric definitions*.
2. **Export frequency** — ✅ **settled 2026-08-12: incremental exports every 6 hours**
   (EventBridge). Incremental (not full) so cost tracks changed-data volume, not cadence;
   requires PITR (already enabled). Tier-1 counters already serve live KPIs, so 6h is ample
   freshness for the ad-hoc Athena lake.
3. **QuickSight or app-rendered charts** — decide after step 5.
4. **Retention** — ⏭ **deferred to post-MVP.** No deletion or retention windows during the
   initial testing phase (test data is disposable, cleared between cycles). S3-export lifecycle
   + DynamoDB TTL land after testing. Baseline staging-bucket controls still apply meanwhile.
