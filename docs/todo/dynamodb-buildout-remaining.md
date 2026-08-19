# Remaining DynamoDB buildout (analytics, aggregates, isolation)

*Post-MVP continuation of the DynamoDB set · [index](../README.md) · extends the
[data model](../dynamodb-data-model.md) and the [analytics addendum](./analytics-plane-addendum.md)*

**Status:** the operational store is live; these are the **post-MVP / pre-go-live** phases that
remain. Direction is decided ([ADR 0002](../adr/0002-datastore-dynamodb.md)); every decision this
work depends on is already settled in the docs above — nothing here is decision-bearing, it is
execution sequencing.

All infra is Terraform, applied through CI (never local `apply`), per the architecture standard.

## Already done (context)

The original buildout plan's first two phases shipped and were retired into this doc:

- **Table (Terraform)** — `aws_dynamodb_table` (pk/sk, on-demand, SSE-KMS), GSI1 (checks timeline),
  GSI2 (site worklist), GSI4/GSI5 (condition history + unresolved queue), PITR + Streams
  (`NEW_AND_OLD_IMAGES`) on, TTL attribute wired-but-inactive, CCSF tags. Applied to the dev account
  via CI 2026-08-18. See [infra/modules/app/main.tf](../../infra/modules/app/main.tf).
- **App on DynamoDB** — Prisma fully removed; `@aws-sdk/lib-dynamodb` Document Client; the real
  `SITE#`/`CHECK#`/`ART#`/`ANALYSIS#`/`TASK#`/`CONDITION#` item model (via the analysis-backend
  Lambdas) writes and reads through the handlers, proven end-to-end on the local harness.

The **city escalation queue (GSI3)** was deferred here from the start; **retention** (TTL
activation, S3-export lifecycle, media expiration) is a separate post-MVP pass tracked in the
[MVP-TODO](../inprogress/MVP-TODO.md) post-MVP section.

---

## Phase 3 — Seed representative data

- `backend/scripts/local-seed.mjs` (local) and a small dev-account seeder so exports/queries have
  realistic content (multiple sites, checks across dates, varied severities). Today the harness's
  `ensure-infra` seeds only site codes, not shaped check history.

**Done when:** the dev-account table holds enough shaped data to make the Phase 4 reports meaningful.

## Phase 4 — T2a analytics pipe  🎯 *prototype milestone*

**Where:** new Terraform, likely `infra/modules/app/analytics.tf`.

- `aws_s3_bucket` for the analytics lake (KMS, public-access-block, lifecycle — mirror the
  existing bucket patterns).
- Scheduled **incremental DynamoDB S3 Export** (EventBridge rule, **every 6 hours**; requires PITR).
- **Glue** database + table describing the export schema.
- **Athena** workgroup + results bucket (encrypted).
- Run the three queries from the [addendum](./analytics-plane-addendum.md) in the Athena console.

**Local-testable:** ❌ cloud-only (export/Glue/Athena) — this is the cloud-dev-account infra wiring.

**Done when:** a scheduled 6-hour incremental export lands in S3, Glue sees it, and the three
city-report queries return results in Athena. **At this point you can feel the system end to end.**

## Phase 5 — Tier 1 live aggregates

- Aggregator **Lambda** subscribed to the table Stream; maintains **daily**
  `STATS#<yyyy-mm-dd>/SITE#<id>` counter items (raw components: checksCompleted, severitySum,
  issueCount, hazardCount) via atomic `ADD`, guarded for **idempotent** reprocessing. Scores are
  computed at read via a shared scoring module (cleanliness/compliance formulas from the
  [data model](../dynamodb-data-model.md) *Metric definitions*), not stored. Neither the aggregator
  nor the scoring module exists yet; the Stream is enabled and its ARN is output, but nothing
  consumes it.
- **Citywide reporting KPI reads:** wire the app's KPI reads (best/worst, compliance) to a single
  `Query` on the counter items — the MVP slice of the reporting-API plan, served without scans.

**Local-testable:** partially — the aggregator logic runs against DynamoDB Local; real Stream
triggering is validated in the cloud dev account.

**Done when:** submitting checks updates counters live, and a ranking query returns sorted
per-site stats without a scan.

## Phase 6 — IAM tenant isolation *(before any real tenant data / go-live)*

The real-data half of the **Option 3 (device-as-site)** auth decision (see
[security-review.md](../security-review.md)); needs the shared device-provisioning / STS-vending
backend (also required by transcription). Cognito user pool + `custom:siteId` schema attribute
already exist; the isolation enforcement does not.

- Cognito **`custom:siteId`** attribute set at admin creation; carried in the JWT.
- **Device principal** = site-scoped identity (registered by the admin).
- IAM roles with `dynamodb:LeadingKeys = SITE#${custom:siteId}` so a site/device physically
  cannot read another site's partition.
- City reviewer role scoped to **GSI3 read** only.

> Ordered after the prototype because a single-dev dev account doesn't exercise multi-tenant
> isolation — but this **must land before real multi-site data or go-live.**

**Done when:** a token scoped to site A cannot read site B's items (verified negative test).

## Phase 7 — GSI3 city escalation queue

Task `type` (`onsite` | `city_escalation`) is already classified by app logic (`task-routing.js`)
and stamped on the task; this phase adds the **cross-site queue view and escalation integrations**
on top.

- Add GSI3 (sparse, `city_escalation` tasks) to the table — addable to the live table with no
  rebuild; wire the city queue view (AP11).

**Done when:** an escalated task appears in the cross-site `ESCALATION#open` query.

## Phase 8 — Dashboards *(optional)*

- QuickSight, or render charts in the app via the Athena API. Decide after Phase 4.

---

## Cross-cutting

- **CI/CD:** all Terraform plan/apply runs in GitHub Actions against remote state (S3 +
  DynamoDB lock). Devs never `apply` locally.
- **Security:** run the repo's security tooling on new Terraform (checkov) and the aggregator
  Lambda; least-privilege IAM on every new role.

## Acceptance criteria (remaining)

1. 6-hour incremental export → Athena answers the three city-report queries (Phase 4). 🎯
2. Live KPI counters update on write and read without scans (Phase 5).
3. Cross-tenant isolation enforced in IAM, verified by a negative test (Phase 6).
4. No click-ops anywhere; every resource is Terraform, every apply is in CI.

## Open decision

- **Export cadence** settled (incremental every 6 hours). **QuickSight vs app-rendered charts**
  (Phase 8) still open — decide after Phase 4.
