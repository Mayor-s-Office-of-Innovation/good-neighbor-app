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

The completed 3-step frontend migration, in order:

1. **[js-and-jsdoc-migration-plan.md](./archive/js-and-jsdoc-migration-plan.md)** — _Step 1._ Drop
   TypeScript syntax for JavaScript + JSDoc (type safety via `tsc --checkJs`, no transpile).
   _Done — backend + repo config; the standing choice is codified in [AGENTS.md](../AGENTS.md). Archived._
2. **[gnp-frontend-migration-plan.md](./gnp-frontend-migration-plan.md)** — _Step 2._ Adopt
   the `gnp` prototype as `frontend/`. _Frontend port done and green; still the tracker for
   the open backend/auth/deploy decisions (D1–D4, I1) and the deferred offline pass._

Step 3 (continue features from `gnp`'s design docs) has not started.

## Database direction & local dev (planning set, Aug 2026)

These five docs form one thread: the decision to move from Postgres/Prisma to **DynamoDB**,
the data model, city-wide reporting, how to run the backend locally, and how to build it all.
The **direction is decided** (DynamoDB — [ADR 0002](./adr/0002-datastore-dynamodb.md)); the
three once-open decisions are settled too (metric formulas settled; city cross-site queue
deferred post-MVP; retention deferred except the media bucket's ~7-day lifecycle). **Read them
in this order:**

1. **[dynamodb-database-decision.md](./archive/dynamodb-database-decision.md)** — _start here._ Why
   DynamoDB over Postgres, the ripple effects, and the honest Postgres fork. The "should we?"
   _(Archived — [ADR 0002](./adr/0002-datastore-dynamodb.md) is now the canonical record; kept for the backing rationale.)_
2. **[dynamodb-data-model.md](./inprogress/dynamodb-data-model.md)** — the single-table model, access
   patterns, GSIs, tenant isolation, and the identity model (device-as-site). The "how it's
   shaped."
3. **[analytics-plane-addendum.md](./todo/analytics-plane-addendum.md)** — city-wide reporting:
   Tier 1 live counters + Tier 2 (S3-export → Athena), with complexity and cost (~$5–15/mo).
   Extends doc 2. The "how reporting works."
4. **[local-dev-environment-plan.md](./archive/local-dev-environment-plan.md)** — the Docker-free local
   harness (DynamoDB Local / ElasticMQ), plus _Alternatives considered_ (why not Architect /
   SAM / LocalStack). The "how we run it locally." _Harness built & verified; run commands live in
   [dev-commands.md](./dev-commands.md). Archived — kept for the alternatives-considered rationale._
5. **[dynamodb-buildout-plan.md](./inprogress/dynamodb-buildout-plan.md)** — _capstone._ The phased
   Terraform + code build plan (table → app cutover → analytics), sequenced to a queryable
   Athena prototype. References docs 1–4. The "how we build it."

**Just want the decision?** Read 1. **Deciding in a meeting?** 1 → 2 → 3, then the open
decisions consolidated in 5's Phase 0. **Building it?** 5, referring back as needed.

## Backend build plans (seams with a decided direction)

- **[analysis-backend-lambdas-plan.md](./inprogress/analysis-backend-lambdas-plan.md)** — the perimeter-check
  API + server-mediated analyze path: client uploads via **presigned PUT to GNP's own S3 bucket** →
  an **async worker** reads it back, base64-encodes, makes a per-artifact analyzer call (`x-api-key`
  from Secrets Manager) → adapt + persist `SITE#/CHECK#` items (media at rest ~7 days, admin review
  via presigned GET). Phased so A–D build now behind a stub; only live E2E waits on the analyzer
  deploying. Grounded in [D1/D2/D3](./gnp-frontend-migration-plan.md) + the
  [data model](./inprogress/dynamodb-data-model.md).

## Frontend ↔ backend wiring (plan, Aug 2026 — **done, archived**)

- **[archive/frontend-api-wiring-plan.md](./archive/frontend-api-wiring-plan.md)** — wire the field
  app to the backend with a **thin online `api.js`** (write-on-submit, read-on-load, one short poll
  for async results) rather than a sync system. The `synced:false` / sync-layer machinery is
  offline-only, so it defers with offline. Depended on the analysis-backend Step C endpoints.
  **Done for MVP (2026-08-16)** — write+read cutover, photo leg E2E, worklist on real `listTasks`,
  hazard triage off the authoritative `TASK#.type` (client mirror deleted); only the post-MVP
  confidence-% placeholder remains. **Archived.**

## Frontend — design & UI

- **[frontend-design-system.md](./frontend-design-system.md)** — living reference for building a
  screen to spec from the token/class system (`tokens.css` / `app.css` are the source of truth).
- **[page-transitions-plan.md](./todo/page-transitions-plan.md)** — View Transitions API screen
  animations (Phase 0 baseline + Phase 1 directional slides). _Not started._

## Deploy & CI/CD (plan, Aug 2026)

- **[deploy-cicd-plan.md](./inprogress/deploy-cicd-plan.md)** — the plan to move from manual, single-role
  deploys to a **2-environment (`dev`/`prod`), 2-branch** pipeline: merge to `dev`→dev auto,
  publish a **GitHub Release** from `main` (admins-only)→prod behind a required-approval pause;
  OIDC-only creds; per-env S3/CloudFront with env-scoped invalidation; branch/environment
  protection; Terraform rollback runbook. Bootstrap + deploy workflows built; remaining is the
  frontend publish (Phase 4) and the `/health` smoke test. Gates the deploy items in
  [MVP-TODO](./inprogress/MVP-TODO.md); closes the open [SDLC Level 2](./sdlc-level-2-checklist.md) deploy items.

## Other docs in this directory

- [architecture.md](./architecture.md), [adr/](./adr/) — architecture notes and decision records
- [dev-commands.md](./dev-commands.md) — developer command reference (setup, CI checks, local harness)
- [sdlc-level-2-checklist.md](./sdlc-level-2-checklist.md), [security-review.md](./security-review.md) — SDLC / security process

## Archive

Docs whose work is **done and codified elsewhere**, or **deferred post-MVP** — kept for the
historical/design record, not part of the active plan set. See [archive/](./archive/):

- [archive/js-and-jsdoc-migration-plan.md](./archive/js-and-jsdoc-migration-plan.md) — Step 1 migration (done; standing choice now in [AGENTS.md](../AGENTS.md)).
- [archive/local-dev-environment-plan.md](./archive/local-dev-environment-plan.md) — local harness (built; commands in [dev-commands.md](./dev-commands.md)).
- [archive/transcription-architecture.md](./archive/transcription-architecture.md), [archive/transcription-STATUS.md](./archive/transcription-STATUS.md) — transcription feature docs (forward-looking; post-MVP, not wired into Phase 1).
- [archive/deploy-admin-bootstrap.md](./archive/deploy-admin-bootstrap.md) — the AWS-admin bootstrap runbook (done; OIDC provider + state backend + per-env deploy roles created). Living deploy doc is [deploy-cicd-plan.md](./inprogress/deploy-cicd-plan.md).

## ADRs — `adr/`

**A**rchitecture **D**ecision **R**ecords: short, numbered, immutable notes capturing a
significant architecture decision, its context, and the alternatives weighed — one file per
decision (`NNNN-title.md`). They're the durable "why" behind the current design. We **supersede,
never rewrite or delete**: a decision that changes gets a new ADR, and the old one's Status is
marked superseded with a pointer forward (see [ADR 0001](./adr/0001-architecture-stack.md) →
[ADR 0002](./adr/0002-datastore-dynamodb.md), the Postgres/Prisma → DynamoDB pivot).
