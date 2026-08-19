# DynamoDB Data Model — Perimeter Checks

*DynamoDB planning set (doc 2 of 5) · [index](../README.md) · ← [decision](../archive/dynamodb-database-decision.md) · next → [analytics addendum](../todo/analytics-plane-addendum.md)*

**Status:** Draft for review — validates the [database decision](../archive/dynamodb-database-decision.md)
against real access patterns
**Date:** 2026-08-12

Purpose: model the domain as far as we've thought it through, and — most importantly —
surface any access pattern DynamoDB *can't* do natively before we commit. **Verdict up front:
DynamoDB is a strong fit. There are no dealbreakers.** There are three patterns to consciously
design for (cross-site rollups, "missing check" detection, and the device identity model),
all with standard mitigations documented below.

## Domain

- **~400 Sites**, each a building. Strict tenant isolation: a site sees only its own data.
- Each site has an **Admin** (Cognito user) who does first-run setup on a **shared device**
  that lives at the front desk and gets carried around for photos.
- **Perimeter checks** happen **3× daily** per site, performed by staff who **do not log in**.
- Each check has, **per side of the building**, 0–a-few **photos**, optional **audio**, and
  optional **text** — all optional.
- Each check's artifacts are analyzed by the **AI engine**, which returns **issues + a
  severity score**.
- Results become **action items**: business rules either **escalate to the city** (toxic
  material cleanup) or create **on-site staff tasks**.

### Assumptions (please confirm — they shape the model)

1. **The city needs a cross-site queue** of toxic escalations (all sites, one view). This is
   the one deliberately cross-tenant pattern; it drives GSI3. *If the city does not need this,
   we drop GSI3 and the model gets simpler.*
2. **Performers are anonymous**; a submitted check is attributed to the **site + device**, not
   a person. (See [Identity model](#identity-model).)
3. **Photos/audio live in S3**, not DynamoDB (items store S3 keys). Non-negotiable — see R4.
4. Retention: **media auto-expires at ~7 days** via an S3 lifecycle rule on GNP's own bucket
   (decided 2026-08-13 PM — see [D3](../gnp-frontend-migration-plan.md)); checks/analysis retention
   (DynamoDB TTL) is still unspecified (post-MVP).

## Identity model (this matters as much as the tables)

| Principal | Auth | Writes | Scope enforcement |
|---|---|---|---|
| **Admin** | Cognito user, `custom:siteId` claim in JWT | site config, users, devices, resolves/assigns tasks | IAM `LeadingKeys = SITE#<custom:siteId>` |
| **Device** (front-desk tablet) | site-scoped principal (device session), **not** a person | perimeter checks + artifacts | same `LeadingKeys` scoping |
| **Performer** | none (anonymous, operates the device) | — | n/a — attribution is device+site |
| **City reviewer** | separate Cognito group/role | updates escalation status | reads **GSI3 only**, cross-site |

Key decision: **the device is authenticated as the site**, so anonymous performers never need
accounts and every check is still attributed to a site (and a device) for the tenant
partition key. The admin registers the device once during setup.

This model also lets us enforce tenant isolation **in IAM, not just app code**: site/device
roles carry a `dynamodb:LeadingKeys` condition pinned to `SITE#${custom:siteId}`, so a
compromised or buggy client physically cannot read another site's partition. That directly
satisfies "sites don't share data" at the platform layer.

## Table design

**Single table**, `gnp-<env>-app`, partition key `pk`, sort key `sk`. Rationale for single-
table here isn't the usual "save queries at scale" argument (volume is tiny — see below); it's
that **all of a tenant's data shares one partition-key prefix**, which is what makes the IAM
`LeadingKeys` isolation above possible and co-locates a check's header + artifacts + analysis
for one-query retrieval.

IDs are **ULIDs** (lexicographically time-sortable), so `CHECK#<ulid>` sorts chronologically
without a separate timestamp in the key.

### Item types

| Entity | `pk` | `sk` | Notes |
|---|---|---|---|
| Site config | `SITE#<siteId>` | `#META` | name, address, timezone, setup state |
| User profile | `SITE#<siteId>` | `USER#<sub>` | admin roster; JWT usually avoids the lookup |
| Device | `SITE#<siteId>` | `DEVICE#<deviceId>` | label, registeredBy, lastSeenAt |
| **Check header** | `SITE#<siteId>` | `CHECK#<checkId>` | status, startedAt, sides, issueCount, maxSeverity; **+ synthesized scorecard at `complete`** (see note) |
| **Artifact** (per side) | `SITE#<siteId>` | `CHECK#<checkId>#ART#<side>#<artifactId>` | S3 keys, text, capturedAt |
| **Analysis** (per artifact) | `SITE#<siteId>` | `CHECK#<checkId>#ANALYSIS#<artifactId>` | concerns[], grade, rubricVersion (raw service output) |
| **Action item / task** | `SITE#<siteId>` | `TASK#<taskId>` | type (onsite\|city_escalation), category, severity, status |

Because the header and its children all begin with `CHECK#<checkId>`, the **check detail
screen is a single query**: `pk = SITE#x AND begins_with(sk, "CHECK#<checkId>")` returns the
header, every artifact, and every analysis together.

> **Synthesis lives on the header (decided 2026-08-14).** One `CHECK#<checkId>` = **one full
> perimeter run across all sides**; there is **no separate "perimeter synthesis" item**. At
> `complete`, the analysis-backend worker writes the synthesized check-level scorecard **onto the
> existing header**: `grade` (worst of Excellent<Good<Fair<Poor<Very Poor across the check's
> artifacts — adopted from the service `general_conditions.label`), a per-category rollup
> `[{ category, maxRating, sourceArtifactIds }]`, `rubricVersion`, and `synthesizedAt`.
> Point-in-time, written once. **Why on the header:** the checks list view (AP6) is a single **GSI1**
> query over *headers only* — putting `grade` on the header means the list shows each check's grade
> with no per-check fan-out into `ANALYSIS#` items. Raw per-artifact output stays in the
> `ANALYSIS#` items (`concerns[]`); the header is the synthesis of them. See
> [analysis-backend plan](./analysis-backend-lambdas-plan.md) § adapter/synthesis.

### Global secondary indexes

| GSI | Partition | Sort | Sparse on | Serves |
|---|---|---|---|---|
| **GSI1** checks timeline | `SITE#<siteId>` | `<startedAt ISO>` | check headers | list recent checks, date ranges, "were 3 done today" |
| **GSI2** site worklist | `SITE#<siteId>#TASK#<status>` | `<createdAt>#<kind>#<severity>#<taskId>` | tasks | staff's open action items, newest-first from the index (severity re-sorted in-app per page — see AP10) |
| **GSI3** city queue | `ESCALATION#<status>` | `<severity>#<createdAt>#<siteId>` | `city_escalation` tasks only | cross-site toxic-cleanup queue for the city |

All three are **sparse** — only the relevant item type carries the GSI keys — so each index
stays small and every listing is a clean query with no filtering.

## Access patterns → queries (every one is a single query, no scans)

| # | Pattern | Operation |
|---|---|---|
| AP1 | Get site config | `GetItem` `SITE#x` / `#META` |
| AP2 | List a site's users | `Query` `SITE#x`, `begins_with(sk,"USER#")` |
| AP3 | Resolve admin → site | from JWT `custom:siteId` (no query) |
| AP4 | List devices | `Query` `SITE#x`, `begins_with(sk,"DEVICE#")` |
| AP5 | Submit a check + artifacts | `TransactWrite` (header + artifacts), idempotent on `checkId` |
| AP6 | List recent / today's checks | `Query` **GSI1** `SITE#x`, SK date range, newest-first |
| AP7 | Open one check (header+artifacts+analysis) | `Query` base `SITE#x`, `begins_with(sk,"CHECK#<id>")` |
| AP8 | AI writes analysis back | `PutItem` `…#ANALYSIS#…` + `UpdateItem` header severity/status |
| AP9 | Generate action items | `TransactWrite` tasks |
| AP10 | Staff worklist (open) | `Query` **GSI2** `SITE#x#TASK#open`, newest-first; app re-sorts each page most-severe-first (date-first key ⇒ severity ranking holds within a page only — a severity-first index is deferred) |
| AP11 | City escalation queue (all sites) | `Query` **GSI3** `ESCALATION#open` |
| AP12 | Compliance: 3 checks on date D? | `Query` **GSI1** date range, count |
| AP13 | Cross-site analytics / rollups | **not native** — see R2 |

### Task ownership & escalation — scope (decided 2026-08-12)

Each task's owner is decided by **app logic in this repo**, not the analyzer. After the AI
analysis returns, the app derives findings, creates the action items, classifies each as
`onsite` or `city_escalation`, assigns them, and **batch-inserts** them (AP9 `TransactWrite`) —
the owner is resolved *before* the task is shown to the user. The `type` stamp is
**point-in-time**: routing rules may change later, but a task is classified once at creation and
never re-classified — old tasks will already be closed by the time rules change. So `type` lands
on the task item from **Phase 1** (it's just an attribute; no index needed for it).

- **In MVP:** the classification logic + the per-site worklist (GSI2, AP10).
- **Post-MVP:** the escalation **integrations** (dispatch/routing to city teams and any external
  systems) *and* the cross-site city-queue view (**GSI3**, AP11). GSI3 is sparse and can be
  added to the live table later with **no rebuild**, so deferring it costs nothing now.

## Scale sanity check

- 400 sites × 3 checks/day = **1,200 checks/day** ≈ 438k/year. Trivial for DynamoDB.
- Per-site partition grows ~1,095 checks/year — **years** before it's large; add a TTL if
  retention policy allows.
- Write throughput is spread across 400 sites × 3/day — **no hot partition** on writes.
- On-demand capacity = pay-per-request, scales to zero. No provisioned sizing needed.

## Fit with existing code

This maps cleanly onto the idempotency design already in the repo: the client mints a ULID
`checkId` and sends it as the `idempotency-key`, and `createCheck` does a conditional write
(`attribute_not_exists(sk)`), so a replayed request can't create a duplicate. (Full offline
queue-and-replay — a Workbox service worker — is **deferred past MVP**; the idempotency contract
is already in place for when it lands.) AI analysis stays async through the existing SQS → worker
path.

> **Current state (analysis-backend Step C, built).** The item types above are now the **live**
> model: `createCheck` / `registerArtifact` / `completeCheck` write real `SITE#`/`CHECK#`/`ART#`/
> `ANALYSIS#` items, keyed off the client-minted ULID `checkId` (the `idempotency-key`) with
> conditional writes. The interim idempotency **receipt** — `pk = SUBMISSION#<requestId>`,
> `sk = #RECEIPT` (the direct successor to the old `OfflineSubmission` row) — still exists, but
> only on the **legacy `/submissions` demo loop** (`workers/process-submission.js`), not the
> check path; a live table may therefore still show `SUBMISSION#…` items alongside the check
> items. See [buildout plan](./dynamodb-buildout-plan.md).

## City-wide reporting & analytics (the CQRS read plane)

City leaders will want cross-site analytical reports — e.g.:

- Which site has the **best / worst cleanliness record**?
- Which sites are **doing their checks regularly**, which aren't?
- How have conditions **changed over time** — for one site, a *set* of sites, or *all* sites
  in aggregate?

These are OLAP (aggregation, ranking, group-by, time-series) queries. DynamoDB is OLTP. **The
rule: never serve these from the operational table with scans or contorted GSIs.** Instead,
split the workload (CQRS) — the app store stays lean, and a read-optimized analytics plane is
fed automatically from **DynamoDB Streams**. This is the intended pattern, not a workaround.

> **Build, complexity & cost details:** see the
> [analytics-plane addendum](../todo/analytics-plane-addendum.md) — how Tier 1 aggregates work
> (incremental on write, never on read), the two Tier 2 builds (start with scheduled S3
> Export → Athena), a cost table (~$5–15/mo without dashboards), and the prototype build order.

### Two tiers

**Tier 1 — live KPI aggregates in DynamoDB** (for fixed, must-be-instant dashboard tiles).
A Streams-triggered Lambda maintains rollup items as checks and analyses land:

| Item | `pk` | `sk` | Serves |
|---|---|---|---|
| Per-site **daily** stats | `SITE#<siteId>` | `#STATS#<yyyy-mm-dd>` | **raw components**: `checksCompleted`, `severitySum`, `issueCount`, `hazardCount` |
| Cross-site daily ranking | `STATS#<yyyy-mm-dd>` | `<score>#<siteId>` | rank all ~400 sites for a day in **one query**; month/quarter views roll up a date range |

**Daily grain is deliberate** (see *Metric definitions* below): the legal 3×/day duty with no
grace is a per-day question, so the day is the atomic counter. Longer windows (month, quarter)
aggregate the daily items across a date range — the base counter never bakes in a period.

The counters store **raw components, never a finished score**. The cleanliness/compliance
numbers are computed *at read* by a single shared scoring module, so a formula change is a
one-function edit with no pipeline rebuild. Cheap, real-time-ish, single-query.

**Tier 2 — analytical lake for open-ended reports** (the third question, and anything
city leaders dream up later):

```
DynamoDB  ──Streams──▶  Firehose  ──▶  S3 (Parquet, partitioned by date)
                                          │
                                     Glue catalog
                                          │
                                   Athena (SQL)  ──▶  QuickSight dashboards
```

Arbitrary `GROUP BY site, month`, `WHERE site IN (…)`, any time window — trivial SQL. This is
what actually answers "trends over time for one site / a set / all in aggregate," because
fixed rollups can't flex to arbitrary site-sets and grains. Eventually consistent (minutes of
lag) — fine for reporting.

### Why this is cheap here

Your data is **small**: ~438k checks/year plus a few artifacts/analyses each ≈ low
single-digit millions of rows/year. Athena scans partitioned Parquet at that size in seconds
for pennies. **No Redshift, no Spark, no warehouse, no VPC.** The analytics are easy precisely
*because* the volume is low — the only work is standing up the pipe (all in Terraform).

### Does this change the database decision? (honest take)

A primary need for cross-site analytical reporting is the **strongest argument for Postgres**
we've hit — in a relational store these reports are just SQL, no pipeline. Weighing it fairly:

- These are two different workloads (tenant-isolated OLTP vs cross-tenant OLAP) with two
  different optimal stores. **CQRS is the right answer regardless of the operational engine** —
  even a Postgres app would likely offload city-wide reporting to a replica/warehouse rather
  than let it contend with the transactional path.
- At this volume a single Postgres *could* serve both, which is a real simplification — but it
  costs us the VPC-free, scales-to-zero operational model, the **IAM tenant isolation across
  400 sites** (`LeadingKeys`), and Lambda connection pooling (RDS Proxy) comes back.
- **Recommendation: stay with DynamoDB + the Tier 1/Tier 2 read plane.** The operational wins
  are specific and substantial, and the analytics plane is cheap and low-maintenance at this
  scale. If the team would rather avoid running *any* streaming pipeline, the fork is
  "Postgres as a single store for both" — documented in the decision doc's Postgres fork.

### Metric definitions (settled 2026-08-12 — product decision)

"Best cleanliness record" and "regularity" were undefined; these are the agreed MVP formulas.
Both are computed **at read** from the raw daily-counter components by a single shared scoring
module (`scoring`, imported by the Tier-1 aggregator and the KPI read endpoints), so a
definition change is a one-function edit — no stored score to migrate, and the Tier-2 Athena
SQL simply mirrors the module.

- **Cleanliness score — unweighted.** All 12 categories count equally (no per-category
  weights). Per check the raw component is `severitySum` = plain sum of the 12 ratings.
  Site/period cleanliness = `sum(severitySum) / sum(checksCompleted)` = **average severity per
  check**; lower = cleaner. The formula is **scale-agnostic**; the per-category rating range is
  **owned by the analysis-service rubric** (0–5 today → max `severitySum` = 60; earlier assumed
  0–3 → 36). Stamp `rubricVersion` on `ANALYSIS` items and never mix scales within one rollup.
  `issueCount` (ratings > 0) and `hazardCount` (hazard = true) are also stored as raw components
  for alternate formulas later, but are not in the headline number.

  > **⚠ Superseded 2026-08-14 — this "unweighted average of 12 category severities" formula no
  > longer holds.** The GNA rubric (`good-neighbor-app` v1.0.0) merged in Beaudry's analyzer, and
  > the service now returns an **exceptions list** (`identified_conditions_of_concern[]`) — only
  > categories of concern, not a severity for every category — plus a **server-computed overall
  > grade** `general_conditions.label` (Excellent/Good/Fair/Poor/Very Poor, from all category
  > severities × per-category `weighting`). **We adopt that `label` as the check `grade`** rather
  > than averaging: an unweighted mean across a fixed 12 categories is undefined when most
  > categories return no severity, and categories are now explicitly *weighted*. The check `grade`
  > therefore lives on the `CHECK#` header (see synthesis note above), not a computed `severitySum`
  > average. `issueCount`/`maxSeverity` (from the concerns list) survive as raw components. The
  > `hazardCount` component is retired — `hazard_detected` is gone from the contract; per-category
  > `weighting` now lives server-side (baked into the grade), so we store no weighting of our own.
  > The compliance/regularity metric below is **unaffected**. See
  > [analysis-backend plan](./analysis-backend-lambdas-plan.md) § adapter.
- **Regularity / compliance — legal 3×/day, no grace.** `CHECKS_PER_DAY = 3` is a hard
  constant (legal requirement); there is **no grace period** for device outages. Because the
  duty is per-day, compliance is per-day and binary: a day is **compliant iff it had ≥ 3
  checks**. Compliance over a window = `compliant_days / total_days`. (A flat
  `completed ÷ (3 × days)` ratio is rejected — it would let a surplus on one day mask a
  violation on another.)

**Easy to change later.** These defaults are intentionally simple and swappable: counters hold
raw components (never a baked score), the formula lives in one module, and — since initial
testing data is disposable (cleared between test cycles) — formulas can be reshaped during
testing at zero migration cost.

### Infra this adds (all Terraform, no click-ops)

DynamoDB Streams on the table; a Firehose delivery stream; an S3 analytics bucket (KMS,
lifecycle); a Glue database + table schema; an Athena workgroup; QuickSight. This elevates the
decision doc's **R2** from "accepted tradeoff, do later" to a **first-class launch
requirement** — the pipe should be in the initial Terraform, not deferred.

## Risks / things DynamoDB can't do natively — and the workaround

| # | Risk | Verdict | Mitigation |
|---|---|---|---|
| **R1** | City needs a **cross-site** view (violates per-site partitioning) | Solved | GSI3 collects `city_escalation` tasks across sites. Toxic escalations are rare, so the `ESCALATION#open` partition stays cool; shard the key later only if volume ever demands it. |
| **R2** | **Cross-site analytics / rollups** (city-wide reports — see [dedicated section](#city-wide-reporting--analytics-the-cqrs-read-plane)) | **First-class launch requirement**, not a "later" | Tier 1 live aggregates in DynamoDB (Streams → counter items) + Tier 2 lake (Streams → S3 → Athena → QuickSight). Cheap at this volume. |
| **R3** | Detecting a **missing** check (a site did <3 today) — "proving a negative" | Minor | Scheduled EventBridge sweep iterates the site registry and checks GSI1 counts; can't be a single query, but it's a cron job, not a hot path. |
| **R4** | Photos/audio exceed the **400 KB item limit** | Handled by design | Blobs go to the existing S3 uploads bucket; items store S3 keys + use presigned URLs. Never store media in the item. |
| **R5** | Tenant isolation must be **airtight** across 400 tenants | Strength, not risk | IAM `dynamodb:LeadingKeys = SITE#${custom:siteId}` enforces isolation at the platform layer, below the app. |
| **R6** | Anonymous performers → **no per-person attribution** | By design | Attribution is site + device. If per-person is ever needed, add a device-local performer PIN/roster; not required now. |
| **R7** | GSI2 status changes rewrite index entries on every task transition | Normal | Expected DynamoDB behavior; volume is tiny. |

**None of these blocks the DynamoDB direction.** R1 and R2 are the two that need a conscious
decision (build GSI3? stand up the Streams→Athena path now or later?); the rest are routine.

## Open questions

1. Confirm the **city cross-site queue** (Assumption 1) — build GSI3, or drop it?
2. **Retention** policy for checks and photos → drives DynamoDB TTL and S3 lifecycle.
3. Cross-site analytics is now a **launch requirement** (city-wide reports). Confirm scope:
   Tier 1 live KPIs only, or Tier 2 lake at launch too? And **agree the metric definitions**
   (cleanliness score, regularity) — reports are meaningless without them.
4. Single-table (recommended) vs per-entity tables — confirm, given the isolation rationale.
5. Per-side artifact model: one artifact item per side (current), or allow multiple artifacts
   per side? (SK already includes `<artifactId>` to keep the door open.)
