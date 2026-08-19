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

**[MVP-TODO.md](./MVP-TODO.md)** — the single task list on the way to a deployed MVP, at the
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

1. **[dynamodb-database-decision.md](./dynamodb-database-decision.md)** — _start here._ Why
   DynamoDB over Postgres, the ripple effects, and the honest Postgres fork. The "should we?"
2. **[dynamodb-data-model.md](./dynamodb-data-model.md)** — the single-table model, access
   patterns, GSIs, tenant isolation, and the identity model (device-as-site). The "how it's
   shaped."
3. **[analytics-plane-addendum.md](./analytics-plane-addendum.md)** — city-wide reporting:
   Tier 1 live counters + Tier 2 (S3-export → Athena), with complexity and cost (~$5–15/mo).
   Extends doc 2. The "how reporting works."
4. **[local-dev-environment-plan.md](./archive/local-dev-environment-plan.md)** — the Docker-free local
   harness (DynamoDB Local / ElasticMQ), plus _Alternatives considered_ (why not Architect /
   SAM / LocalStack). The "how we run it locally." _Harness built & verified; run commands live in
   [dev-commands.md](./dev-commands.md). Archived — kept for the alternatives-considered rationale._
5. **[dynamodb-buildout-plan.md](./dynamodb-buildout-plan.md)** — _capstone._ The phased
   Terraform + code build plan (table → app cutover → analytics), sequenced to a queryable
   Athena prototype. References docs 1–4. The "how we build it."

**Just want the decision?** Read 1. **Deciding in a meeting?** 1 → 2 → 3, then the open
decisions consolidated in 5's Phase 0. **Building it?** 5, referring back as needed.

## Backend build plans (seams with a decided direction)

- **[analysis-backend-lambdas-plan.md](./analysis-backend-lambdas-plan.md)** — the perimeter-check
  API + server-mediated analyze path: client uploads via **presigned PUT to GNP's own S3 bucket** →
  an **async worker** reads it back, base64-encodes, makes a per-artifact analyzer call (`x-api-key`
  from Secrets Manager) → adapt + persist `SITE#/CHECK#` items (media at rest ~7 days, admin review
  via presigned GET). Phased so A–D build now behind a stub; only live E2E waits on the analyzer
  deploying. Grounded in [D1/D2/D3](./gnp-frontend-migration-plan.md) + the
  [data model](./dynamodb-data-model.md).
- **[guidance-workflow-backend-plan.md](./guidance-workflow-backend-plan.md)** — design for the
  rule-driven action/escalation backend that consumes analyzer assessments, applies the
  `actions-escalations-rules.csv` policy table, asks required user follow-up questions, and
  creates/resolves guidance tasks in a deterministic sequence. Phases 1–7 are implemented.

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
- **[mvp-design-trim-plan.md](./mvp-design-trim-plan.md)** — screen-by-screen trim of prototype
  features down to the MVP surface (partly built; some screens still planned).
- **[page-transitions-plan.md](./page-transitions-plan.md)** — View Transitions API screen
  animations (Phase 0 baseline + Phase 1 directional slides). _Not started._

## Deploy & CI/CD (plan, Aug 2026)

- **[deploy-cicd-plan.md](./deploy-cicd-plan.md)** — the plan to move from manual, single-role,
  dev/prod-only deploys to a **3-environment (`dev`/`staging`/`prod`), gated, auto-promoting**
  pipeline: `main`→dev auto, tag→staging, tag→prod behind two-admin approval; OIDC-only creds;
  per-env S3/CloudFront with env-scoped invalidation; branch/environment protection; Terraform
  rollback runbook. Its one external blocker is the **admin-account bootstrap contract** (role
  ARNs + remote state). Gates the deploy items in [MVP-TODO](./MVP-TODO.md); closes the open
  [SDLC Level 2](./sdlc-level-2-checklist.md) deploy items.
- **[deploy-admin-bootstrap.md](./deploy-admin-bootstrap.md)** — the hand-to-the-AWS-admin
  runbook that clears that blocker: step-by-step OIDC provider + Terraform state backend +
  per-env deploy roles (with copy-paste CLI and trust/permissions JSON), then the maintainer
  follow-up (GitHub Environments, secrets, backend enable, OIDC smoke test).

## Other docs in this directory

- [architecture.md](./architecture.md), [adr/](./adr/) — architecture notes and decision records
- [dev-commands.md](./dev-commands.md) — developer command reference (setup, CI checks, local harness)
- [minio-local-s3.md](./minio-local-s3.md) — local S3 via MinIO (harness Step D): why it's needed with a remote analyzer, the full media loop, gotchas, and the required `.env.local` edits
- [sdlc-level-2-checklist.md](./sdlc-level-2-checklist.md), [security-review.md](./security-review.md) — SDLC / security process

## Archive

Docs whose work is **done and codified elsewhere**, or **deferred post-MVP** — kept for the
historical/design record, not part of the active plan set. See [archive/](./archive/):

- [archive/js-and-jsdoc-migration-plan.md](./archive/js-and-jsdoc-migration-plan.md) — Step 1 migration (done; standing choice now in [AGENTS.md](../AGENTS.md)).
- [archive/local-dev-environment-plan.md](./archive/local-dev-environment-plan.md) — local harness (built; commands in [dev-commands.md](./dev-commands.md)).
- [archive/transcription-architecture.md](./archive/transcription-architecture.md), [archive/transcription-STATUS.md](./archive/transcription-STATUS.md) — transcription feature docs (forward-looking; post-MVP, not wired into Phase 1).
