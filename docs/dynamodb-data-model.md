# DynamoDB Data Model — Perimeter Checks

*Data-model reference · [index](../README.md) · ← [decision](./adr/0002-datastore-dynamodb.md)*

**Status:** Live model — this is what the app writes and reads today
**Date:** 2026-08-12 · updated 2026-09-02 for the built state

Purpose: the factual reference for the single-table model — item shapes, keys, GSIs, and
access patterns. The datastore decision and its alternatives live in
[ADR 0002](./adr/0002-datastore-dynamodb.md). Three patterns need conscious design
(cross-site rollups, "missing check" detection, and the device identity model); all have
standard mitigations documented below.

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

### Domain facts (shape the model)

1. **The city needs a cross-site queue** of toxic escalations (all sites, one view). This is
   the one deliberately cross-tenant pattern; it drives GSI3. *Deferred post-MVP — GSI3 is
   sparse and addable with no rebuild.*
2. **Performers are anonymous**; a submitted check is attributed to the **site + device**, not
   a person. (See [Identity model](#identity-model).)
3. **Photos/audio live in S3**, not DynamoDB (items store S3 keys). Non-negotiable — see R4.
4. Retention: media is **designed** to auto-expire at ~7 days via an S3 lifecycle rule on GNP's own
   bucket, but that expiration is **not yet enforced** (deferred for the POC — pre-launch TODO);
   checks/analysis retention (DynamoDB TTL) is post-MVP.

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
| **Assessment report** | `SITE#<siteId>` | `ASSESSMENT#<assessmentId>` | status, policyVersion, grade, location, summary counts, raw assessment |
| **Condition** | `SITE#<siteId>` | `ASSESSMENT#<assessmentId>#COND#<conditionId>` | canonical category, severity, answers, outcome, status, taskIds (see [guidance workflow](./architecture.md#guidance-workflow-rule-driven-tasks)) |
| **Action item / task** | `SITE#<siteId>` | `TASK#<taskId>` | type (onsite\|city_escalation), kind, ruleId, policyVersion, category, severity, status |

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
> `ANALYSIS#` items (`concerns[]`); the header is the synthesis of them. See the adapter/synthesis
> modules [`adapt-scorecard.js`](../backend/src/analysis/adapt-scorecard.js) +
> [`synthesize-check.js`](../backend/src/analysis/synthesize-check.js).

### Global secondary indexes

| GSI | Partition | Sort | Sparse on | Serves | Status |
|---|---|---|---|---|---|
| **GSI1** checks timeline | `SITE#<siteId>` | `<startedAt ISO>` | check headers | list recent checks, date ranges, "were 3 done today" | built |
| **GSI2** site worklist | `SITE#<siteId>#TASK#<status>` | `<createdAt>#<kind>#<severity>#<taskId>` | tasks | staff's open action items, newest-first from the index (severity re-sorted in-app per page — see AP10) | built |
| **GSI3** city queue | `ESCALATION#<status>` | `<severity>#<createdAt>#<siteId>` | `city_escalation` tasks only | cross-site toxic-cleanup queue for the city | **deferred post-MVP** — sparse, addable with no rebuild |
| **GSI4** condition history | `SITE#<siteId>#CONDITION#SEV#<severity>` | `<reportedAt>#<assessmentId>#<conditionId>` | conditions | list conditions by site/date/severity | built |
| **GSI5** unresolved conditions | `SITE#<siteId>#CONDITION#UNRESOLVED` | `<reportedAt>#SEV#<severity>#<assessmentId>#<conditionId>` | unresolved conditions only | list conditions not yet translated into tasks | built |

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
| AP11 | City escalation queue (all sites) | `Query` **GSI3** `ESCALATION#open` *(post-MVP — GSI3 not yet built)* |
| AP12 | Compliance: 3 checks on date D? | `Query` **GSI1** date range, count |
| AP13 | Cross-site analytics / rollups | **not native** — see R2 |
| AP14 | List assessments by site/date | `Query` **GSI1** `SITE#x#ASSESSMENT`, SK date range |
| AP15 | Conditions of one assessment | `Query` base `SITE#x`, `begins_with(sk,"ASSESSMENT#<id>#COND#")` |
| AP16 | Unresolved conditions | `Query` **GSI5** `SITE#x#CONDITION#UNRESOLVED` |
| AP17 | Guidance read / answers | `GetItem` assessment + condition, `UpdateItem` on answer |

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

> **Current state (built).** The item types above are the **live** model: `createCheck` /
> `registerArtifact` / `completeCheck` write real `SITE#`/`CHECK#`/`ART#`/`ANALYSIS#` items,
> keyed off the client-minted ULID `checkId` (the `idempotency-key`) with conditional writes.
> The interim idempotency **receipt** — `pk = SUBMISSION#<requestId>`, `sk = #RECEIPT` —
> survives only on the legacy `/submissions` demo loop, not the check path.

## City-wide reporting & analytics (the CQRS read plane)

City leaders will want cross-site analytical reports — e.g.:

- Which site has the **best / worst cleanliness record**?
- Which sites are **doing their checks regularly**, which aren't?
- How have conditions **changed over time** — for one site, a *set* of sites, or *all* sites
  in aggregate?

These are OLAP (aggregation, ranking, group-by, time-series) queries. DynamoDB is OLTP, so
these are never served from the operational table with scans or contorted GSIs. The workload
is split (CQRS): the app store stays lean, and a read-optimized analytics plane is fed
automatically from **DynamoDB Streams** (Tier 1) and scheduled S3 exports (Tier 2).

**Tier-1 counter items** (daily grain — the legal 3×/day duty makes the day the atomic
counter; longer windows roll up a date range). Maintained incrementally on write by a
Streams-triggered aggregator Lambda (guarded idempotent — Streams can deliver twice);
reads are a single pre-summed `Query`, never a scan:

| `pk` | `sk` | Attributes |
|---|---|---|
| `SITE#<siteId>` | `#STATS#<yyyy-mm-dd>` | raw components: `checksCompleted`, `issueCount`, `maxSeverity` |
| `STATS#<yyyy-mm-dd>` | `<score>#<siteId>` | cross-site ranking for one day — all ~400 sites in one query |

Counters hold **raw components, never a finished score** — scores are computed at read by
the shared scoring module, so a formula change is a one-function edit. (The severity-sum
components `severitySum`/`hazardCount` from the original design are **retired** — see the
grade-based *Metric definitions* below.)

**Tier 2** is a scheduled incremental DynamoDB **S3 export** (every 6 hours, needs PITR) →
Glue catalog → **Athena** SQL for arbitrary site-sets/grains; a streaming Firehose/Parquet
build (T2b) exists only if near-real-time dashboards ever become a requirement.

Buildout of both tiers is post-MVP, tracked on the issue tracker.

## Metric definitions (settled 2026-08-12 — product decision)

"Best cleanliness record" and "regularity" are defined as follows.
Both are computed **at read** from the raw daily-counter components by a single shared scoring
module (`scoring`, imported by the Tier-1 aggregator and the KPI read endpoints), so a
definition change is a one-function edit — no stored score to migrate, and the Tier-2 Athena
SQL simply mirrors the module.

- **Cleanliness — grade-based (settled 2026-08-14).** The check **grade** is the
  service-computed `general_conditions.label` (Excellent/Good/Fair/Poor/Very Poor, from all
  category severities × per-category `weighting` in the GNA rubric
  (`good-neighbor-app` v1.0.0)), adopted as-is and stamped on the `CHECK#` header (see
  synthesis note above). The service returns an **exceptions list**
  (`identified_conditions_of_concern[]`) — only categories of concern, not a severity for
  every category — so a severity average is undefined. `issueCount`/`maxSeverity` (from the
  concerns list) survive as raw components. `hazardCount` is retired — `hazard_detected` is
  gone from the contract; per-category `weighting` lives server-side (baked into the grade),
  so we store no weighting of our own. See
  [`adapt-scorecard.js`](../backend/src/analysis/adapt-scorecard.js).
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
lifecycle); a Glue database + table schema; an Athena workgroup; QuickSight. Buildout is
post-MVP, tracked on the issue tracker.

## Limitations & workarounds

| # | Limitation | Status | Mitigation |
|---|---|---|---|
| **R1** | City needs a **cross-site** view (violates per-site partitioning) | Deferred post-MVP | GSI3 collects `city_escalation` tasks across sites. Toxic escalations are rare, so the `ESCALATION#open` partition stays cool; shard the key later only if volume ever demands it. |
| **R2** | **Cross-site analytics / rollups** (city-wide reports — see [the CQRS read plane](#city-wide-reporting--analytics-the-cqrs-read-plane)) | Deferred post-MVP | Tier 1 live aggregates in DynamoDB (Streams → counter items) + Tier 2 lake (S3 export → Athena). Cheap at this volume. |
| **R3** | Detecting a **missing** check (a site did <3 today) — "proving a negative" | Minor | Scheduled EventBridge sweep iterates the site registry and checks GSI1 counts; can't be a single query, but it's a cron job, not a hot path. |
| **R4** | Photos/audio exceed the **400 KB item limit** | Handled by design | Blobs go to the existing S3 uploads bucket; items store S3 keys + use presigned URLs. Never store media in the item. |
| **R5** | Tenant isolation must be **airtight** across 400 tenants | Enforced by design | IAM `dynamodb:LeadingKeys = SITE#${custom:siteId}` enforces isolation at the platform layer, below the app. |
| **R6** | Anonymous performers → **no per-person attribution** | By design | Attribution is site + device. If per-person is ever needed, add a device-local performer PIN/roster; not required now. |
| **R7** | GSI2 status changes rewrite index entries on every task transition | Normal | Expected DynamoDB behavior; volume is tiny. |

R1 (GSI3) and R2's buildout are post-MVP, tracked on the issue tracker; the rest are routine.

## Settled questions (for the record)

1. **City cross-site queue** — deferred post-MVP: GSI3 is sparse, addable
   with no rebuild; the queue view ships with escalation integrations.
2. **Retention** — media ~7-day lifecycle designed but not enforced; full retention pass
   post-MVP (tracked on the issue tracker).
3. **Analytics scope & metrics** — Tier 1 live KPIs + Tier 2 S3-export lake, post-MVP
   build; metric definitions settled (see above).
4. **Single table** — confirmed, for the `LeadingKeys` isolation rationale.
5. **Per-side artifact model** — multiple artifacts per side supported (`SK` includes
   `<artifactId>`); in use.
