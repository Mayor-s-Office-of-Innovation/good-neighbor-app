# Docs index

> **Start here.** This is the map of the repo's planning docs — each thread below has its
> own ordered read path and status. If you're an agent getting your bearings, you'll have
> read [AGENTS.md](../AGENTS.md) first (standing choices + what's in flight); this file tells
> you which docs back that up and in what order to read them.
>
> **Current state (2026-08-12):** the frontend migration (Steps 1 & 2) is **done** — the
> backend is JS+JSDoc and the `gnp` prototype is now `frontend/`, built and green. The
> **database direction is decided — DynamoDB** (replacing Postgres/Prisma; see
> [ADR 0002](./adr/0002-datastore-dynamodb.md)); the **backend/auth/deploy seams are still in
> planning**, which is where the remaining open decisions live. New work most likely starts in
> one of the first two threads below.

## MVP tracker (start here for "what's left")

**[MVP-TODO.md](./inprogress/MVP-TODO.md)** — the single task list on the way to a deployed MVP, at the
plan level. Groups done work, blocking decisions, plans still to write, the DynamoDB critical
path, deploy/harden gates, and post-MVP tracks. Each item links to the plan that backs it.

## Migration — frontend (DONE, Aug 2026)

The 3-step frontend migration is complete; the planning docs have been retired and their
decisions codified as ADRs:

1. **JS + JSDoc — [ADR 0004](./adr/0004-javascript-with-jsdoc.md)** — _Step 1._ Drop TypeScript
   syntax for JavaScript + JSDoc (type safety via `tsc --checkJs`, no transpile). Done — backend
   + repo config; the standing choice is codified in [AGENTS.md](../AGENTS.md).
2. **Adopt the `gnp` prototype as `frontend/`** — _Step 2._ Done and green. Its once-open
   decisions are now settled: auth (API-key-per-consumer) and the deferred offline pass are
   tracked in [MVP-TODO](./inprogress/MVP-TODO.md); datastore is
   [ADR 0002](./adr/0002-datastore-dynamodb.md); the backend contract is
   [ADR 0005](./adr/0005-online-api-client-no-sync.md).

Step 3 (continue features from `gnp`'s design docs) has not started.

## Database direction & local dev (planning set, Aug 2026)

These five docs form one thread: the decision to move from Postgres/Prisma to **DynamoDB**,
the data model, city-wide reporting, how to run the backend locally, and how to build it all.
The **direction is decided** (DynamoDB — [ADR 0002](./adr/0002-datastore-dynamodb.md)); the
three once-open decisions are settled too (metric formulas settled; city cross-site queue
deferred post-MVP; retention deferred post-MVP — incl. the media bucket's ~7-day expiration, which
is designed but not yet enforced). **Read them in this order:**

1. **The decision — [ADR 0002](./adr/0002-datastore-dynamodb.md)** — _start here._ Why
   DynamoDB over Postgres, the ripple effects, and the honest Postgres fork. The "should we?"
2. **[dynamodb-data-model.md](./dynamodb-data-model.md)** — the single-table model, access
   patterns, GSIs, tenant isolation, and the identity model (device-as-site). The "how it's
   shaped."
3. **[analytics-plane-addendum.md](./todo/analytics-plane-addendum.md)** — city-wide reporting:
   Tier 1 live counters + Tier 2 (S3-export → Athena), with complexity and cost (~$5–15/mo).
   Extends doc 2. The "how reporting works."
4. **The local harness — [ADR 0006](./adr/0006-docker-free-local-dev-harness.md)** — the
   Docker-free local harness (DynamoDB Local / ElasticMQ), plus _Alternatives considered_ (why
   not Architect / SAM / LocalStack). The "how we run it locally." Built & verified; run commands
   live in [dev-commands.md](./dev-commands.md).
5. **[dynamodb-buildout-remaining.md](./todo/dynamodb-buildout-remaining.md)** — _what's left._
   The table and app cutover shipped; this carries the **post-MVP / pre-go-live** phases
   (seed → analytics pipe → live aggregates → tenant isolation). References docs 1–4. The
   "how we finish it."

**Just want the decision?** Read 1. **Deciding in a meeting?** 1 → 2 → 3. **Building the rest?**
5, referring back as needed.

## Backend build plans (seams with a decided direction)

- **Analysis backend — perimeter-check API + server-mediated analyze path** *(built 2026-08; build
  plan retired on completion).* Client uploads via **presigned PUT to GNP's own S3 bucket** → an
  **async worker** reads it back, base64-encodes, makes a per-artifact analyzer call (`x-api-key`
  from Secrets Manager) → adapt + persist `SITE#/CHECK#` items (admin review via presigned GET).
  As-built container/sequence/ER diagrams in [architecture.md](./architecture.md); item shapes in
  the [data model](./dynamodb-data-model.md). Grounded in D1/D2/D3.
- **[guidance-workflow-backend-plan.md](./guidance-workflow-backend-plan.md)** — design for the
  rule-driven action/escalation backend that consumes analyzer assessments, applies the
  `actions-escalations-rules.csv` policy table, asks required user follow-up questions, and
  creates/resolves guidance tasks in a deterministic sequence. Phases 1–7 are implemented.
- **[media-downscale-sharp.md](./todo/media-downscale-sharp.md)** — follow-up: swap the passthrough
  downscale seam for a real `sharp` resize (long-edge ~1568px → JPEG) before the analyzer call.
  _Deferred — out of the current MVP._

## Frontend ↔ backend wiring (DONE, Aug 2026)

- **Online `api.js` — [ADR 0005](./adr/0005-online-api-client-no-sync.md)** — wire the field
  app to the backend with a **thin online `api.js`** (write-on-submit, read-on-load, one short poll
  for async results) rather than a sync system. The `synced:false` / sync-layer machinery is
  offline-only, so it defers with offline. Depended on the analysis-backend Step C endpoints.
  **Done for MVP (2026-08-16)** — write+read cutover, photo leg E2E, worklist on real `listTasks`,
  hazard triage off the authoritative `TASK#.type` (client mirror deleted); only the post-MVP
  confidence-% placeholder remains.

## Frontend — design & UI

- **[frontend-design-system.md](./frontend-design-system.md)** — living reference for building a
  screen to spec from the token/class system (`tokens.css` / `app.css` are the source of truth).
- **[page-transitions-plan.md](./todo/page-transitions-plan.md)** — View Transitions API screen
  animations (Phase 0 baseline + Phase 1 directional slides). _Not started._

## Deploy & CI/CD (plan, Aug 2026)

- **The decision — [ADR 0007](./adr/0007-deploy-promotion-model.md)** — the **2-environment
  (`dev`/`prod`), 2-branch** promotion model (merge to `dev`→dev auto; publish a **GitHub Release**
  from `main`, admins-only→prod behind an approval pause), OIDC-only creds, and the deliberate
  single-person-path-to-prod trade for a 2-person team. The "why" behind the built pipeline.
- **[prod-cicd.md](./todo/prod-cicd.md)** — _what's left._ The pipeline is built
  and the **dev half is live-proven**; this now tracks only the two remaining prod-side tasks: the
  first **prod release-deploy** (release-tag + approval path untested) and the **rollback runbook
  dry-run**. Gates the deploy items in [MVP-TODO](./inprogress/MVP-TODO.md); closes the open
  [SDLC Level 2](./sdlc-level-2-checklist.md) deploy items.

## Other docs in this directory

- [architecture.md](./architecture.md), [adr/](./adr/) — architecture notes and decision records
- [dev-commands.md](./dev-commands.md) — developer command reference (setup, CI checks, local harness)
- [sdlc-level-2-checklist.md](./sdlc-level-2-checklist.md), [security-review.md](./security-review.md) — SDLC / security process

## ADRs — `adr/`

**A**rchitecture **D**ecision **R**ecords: short, numbered, immutable notes capturing a
significant architecture decision, its context, and the alternatives weighed — one file per
decision (`NNNN-title.md`). They're the durable "why" behind the current design. We **supersede,
never rewrite or delete**: a decision that changes gets a new ADR, and the old one's Status is
marked superseded with a pointer forward (see [ADR 0001](./adr/0001-architecture-stack.md) →
[ADR 0002](./adr/0002-datastore-dynamodb.md), the Postgres/Prisma → DynamoDB pivot).
