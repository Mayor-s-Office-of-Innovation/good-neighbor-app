# Plan: DynamoDB Buildout (table → app cutover → analytics)

*DynamoDB planning set (doc 5 of 5) · [index](./README.md) · ← [local-dev plan](./local-dev-environment-plan.md)*

**Status:** Proposed — runnable build plan, pending decisions in Phase 0
**Date:** 2026-08-12
**Ties together:** the [decision](./dynamodb-database-decision.md), the
[data model](./dynamodb-data-model.md), the [analytics addendum](./analytics-plane-addendum.md),
and the local/cloud split in the [local-dev plan](./local-dev-environment-plan.md).

End-to-end plan to stand up DynamoDB as the operational store and the city-wide reporting
plane — all in Terraform, applied through CI (never local `apply`), per the architecture
standard. Sequenced so we reach a **queryable Athena prototype early** (🎯 after Phase 4), then
harden toward production.

## Phase 0 — Prerequisites & gating decisions

Nothing below starts until the **DynamoDB decision is signed off**. Per-phase gates:

| Decision | Blocks | Status |
|---|---|---|
| DynamoDB adopted (vs Postgres) | everything | pending team sign-off |
| City cross-site queue needed? | Phase 7 (GSI3) | assumed yes |
| Metric formulas (cleanliness, regularity) | Phase 4 *reports* (not the pipe) | **blocking for real reports** |
| Retention policy | TTL in Phase 1, lifecycle in Phase 4 | pending |

The pipe (Phases 1–5) can be built with **placeholder** metric formulas; the *reports* aren't
meaningful until the formulas are agreed.

---

## Phase 1 — DynamoDB table (Terraform)

**Where:** extend [infra/modules/app/main.tf](../infra/modules/app/main.tf) (reuse the existing
`name_prefix`, `aws_kms_key.app`, and `var.tags` patterns).

- `aws_dynamodb_table` with `pk`/`sk`, on-demand billing, SSE using the existing KMS key.
- **GSI1** (checks timeline) and **GSI2** (site worklist). *GSI3 deferred to Phase 7.*
- **PITR enabled** (required for the Phase 4 export; also our backup story).
- **Streams enabled** (`NEW_AND_OLD_IMAGES`) for Phase 5's aggregator.
- **TTL attribute** wired (activated only once retention is decided).
- All **CCSF tags** (`Application`, `ApplicationOwner`, `Environment`, `DataClassification`,
  `InternetExposure`, `AssetCriticality`, `Compliance`).

**Done when:** `terraform plan/apply` in CI creates the table with GSI1/GSI2, PITR + Streams on,
in the dev environment. No local state, no click-ops.

## Phase 2 — App cutover: Prisma → DynamoDB SDK

**Files:** [db.js](../backend/src/db.js), [config.js](../backend/src/config.js),
[handlers/submissions.js](../backend/src/handlers/submissions.js),
[workers/process-submission.js](../backend/src/workers/process-submission.js),
[prisma/schema.prisma](../backend/prisma/schema.prisma), `backend/package.json`.

- Replace `db.js` PrismaClient with a `@aws-sdk/lib-dynamodb` Document Client.
- Add `dynamoTable` to `getConfig()` (env `DYNAMO_TABLE`).
- Rewrite the worker's `upsert` as a conditional `PutCommand`/`UpdateCommand` (idempotent on
  `checkId`, preserving today's `requestId` idempotency semantics).
- Point the submissions/worker items at the `pk`/`sk` shape from the data-model doc.
- Remove Prisma: dependency, `prisma/`, `DATABASE_URL`, `typecheck`/scripts references.
- Update JSDoc types accordingly (keep the `typecheck` gate green).

**Local-testable:** yes — run against **DynamoDB Local** in the Docker-free harness.

**Done when:** `npm test` passes against DynamoDB Local; a submission flows curl → SQS → worker
→ DynamoDB item locally; Prisma is fully removed and `typecheck` is green.

## Phase 3 — Seed representative data

- `scripts/local-seed.mjs` (local) and a small dev-account seeder so exports/queries have
  realistic content (multiple sites, checks across dates, varied severities).

**Done when:** the dev-account table holds enough shaped data to make Phase 4 reports meaningful.

## Phase 4 — T2a analytics pipe  🎯 *prototype milestone*

**Where:** new Terraform, likely `infra/modules/app/analytics.tf`.

- `aws_s3_bucket` for the analytics lake (KMS, public-access-block, lifecycle — mirror the
  existing bucket patterns).
- Scheduled **DynamoDB S3 Export** (EventBridge rule, daily to start).
- **Glue** database + table describing the export schema.
- **Athena** workgroup + results bucket (encrypted).
- Run the three queries from the [addendum](./analytics-plane-addendum.md) in the Athena console.

**Local-testable:** ❌ cloud-only (export/Glue/Athena). This is the infra-wiring the local-dev
plan says belongs in the **cloud dev account**.

**Done when:** a daily export lands in S3, Glue sees it, and the three city-report queries
return results in Athena. **At this point you can feel the system end to end.**

## Phase 5 — Tier 1 live aggregates

- Aggregator **Lambda** subscribed to the table Stream; maintains `STATS#<period>/SITE#<id>`
  counter items via atomic `ADD`, guarded for **idempotent** reprocessing.
- Wire the app's KPI reads (best/worst, compliance) to a single `Query` on the counter items.

**Local-testable:** partially — the aggregator logic runs against DynamoDB Local; real Stream
triggering is validated in the cloud dev account.

**Done when:** submitting checks updates counters live, and a ranking query returns sorted
per-site stats without a scan.

## Phase 6 — IAM tenant isolation (before any real tenant data / go-live)

- Cognito **`custom:siteId`** attribute set at admin creation; carried in the JWT.
- **Device principal** = site-scoped identity (registered by the admin).
- IAM roles with `dynamodb:LeadingKeys = SITE#${custom:siteId}` so a site/device physically
  cannot read another site's partition.
- City reviewer role scoped to **GSI3 read** only.

> Ordered after the prototype because a single-dev dev account doesn't exercise multi-tenant
> isolation — but this **must land before real multi-site data or go-live.**

**Done when:** a token scoped to site A cannot read site B's items (verified negative test).

## Phase 7 — GSI3 city escalation queue *(gated on Phase 0 city-queue decision)*

- Add GSI3 (sparse, `city_escalation` tasks) to the table; wire the city queue view (AP11).

**Done when:** an escalated task appears in the cross-site `ESCALATION#open` query.

## Phase 8 — Dashboards *(optional)*

- QuickSight, or render charts in the app via the Athena API. Decide after Phase 4.

---

## Cross-cutting

- **CI/CD:** all Terraform plan/apply runs in GitHub Actions against remote state (S3 +
  DynamoDB lock). Devs never `apply` locally.
- **Docs to update on cutover:** [AGENTS.md](../AGENTS.md) (drop Prisma/Postgres standing
  choices), and the Prisma/Postgres references in the migration plans.
- **Security:** run the repo's security tooling on new Terraform (checkov) and the aggregator
  Lambda; least-privilege IAM on every new role.

## Acceptance criteria

1. Table + GSIs + PITR + Streams live in the dev account via CI (Phase 1).
2. App runs on DynamoDB with Prisma removed; local tests pass on DynamoDB Local (Phase 2).
3. Daily export → Athena answers the three city-report queries (Phase 4). 🎯
4. Live KPI counters update on write and read without scans (Phase 5).
5. Cross-tenant isolation enforced in IAM, verified by a negative test (Phase 6).
6. No click-ops anywhere; every resource is Terraform, every apply is in CI.

## Open decisions (carried from Phase 0)

1. DynamoDB sign-off.
2. City cross-site queue (Phase 7 on/off).
3. Metric formulas — blocking for meaningful reports.
4. Retention → TTL + S3 lifecycle.
5. Export cadence (daily to start?) and QuickSight vs app-rendered charts.
