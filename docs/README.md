# Docs index

> **Start here.** This is the map of the repo's planning docs — each thread below has its
> own ordered read path and status. If you're an agent getting your bearings, you'll have
> read [AGENTS.md](../AGENTS.md) first (standing choices + what's in flight); this file tells
> you which docs back that up and in what order to read them.
>
> **Current state (2026-08-12):** the frontend migration (Steps 1 & 2) is **done** — the
> backend is JS+JSDoc and the `gnp` prototype is now `frontend/`, built and green. The
> **database direction (DynamoDB) and the backend/auth/deploy seams are still in planning**,
> which is where the open decisions live. New work most likely starts in one of the first
> two threads below.

## Migration — frontend (DONE, Aug 2026)

The completed 3-step frontend migration, in order:

1. **[js-and-jsdoc-migration-plan.md](./js-and-jsdoc-migration-plan.md)** — _Step 1._ Drop
   TypeScript syntax for JavaScript + JSDoc (type safety via `tsc --checkJs`, no transpile).
   _Done — backend + repo config._
2. **[gnp-frontend-migration-plan.md](./gnp-frontend-migration-plan.md)** — _Step 2._ Adopt
   the `gnp` prototype as `frontend/`. _Frontend port done and green; still the tracker for
   the open backend/auth/deploy decisions (D1–D4, I1) and the deferred offline pass._

Step 3 (continue features from `gnp`'s design docs) has not started.

## Database direction & local dev (planning set, Aug 2026)

These five docs form one thread: the decision to move from Postgres/Prisma to **DynamoDB**,
the data model, city-wide reporting, how to run the backend locally, and how to build it all.
All are **Proposed** — pending team sign-off and three open decisions (metric formulas, city
cross-site queue, retention). **Read them in this order:**

1. **[dynamodb-database-decision.md](./dynamodb-database-decision.md)** — _start here._ Why
   DynamoDB over Postgres, the ripple effects, and the honest Postgres fork. The "should we?"
2. **[dynamodb-data-model.md](./dynamodb-data-model.md)** — the single-table model, access
   patterns, GSIs, tenant isolation, and the identity model (device-as-site). The "how it's
   shaped."
3. **[analytics-plane-addendum.md](./analytics-plane-addendum.md)** — city-wide reporting:
   Tier 1 live counters + Tier 2 (S3-export → Athena), with complexity and cost (~$5–15/mo).
   Extends doc 2. The "how reporting works."
4. **[local-dev-environment-plan.md](./local-dev-environment-plan.md)** — the Docker-free local
   harness (DynamoDB Local / ElasticMQ), plus _Alternatives considered_ (why not Architect /
   SAM / LocalStack). The "how we run it locally."
5. **[dynamodb-buildout-plan.md](./dynamodb-buildout-plan.md)** — _capstone._ The phased
   Terraform + code build plan (table → app cutover → analytics), sequenced to a queryable
   Athena prototype. References docs 1–4. The "how we build it."

**Just want the decision?** Read 1. **Deciding in a meeting?** 1 → 2 → 3, then the open
decisions consolidated in 5's Phase 0. **Building it?** 5, referring back as needed.

## Other docs in this directory

- [architecture.md](./architecture.md), [adr/](./adr/) — architecture notes and decision records
- [sdlc-level-2-checklist.md](./sdlc-level-2-checklist.md), [security-review.md](./security-review.md) — SDLC / security process
- [transcription-architecture.md](./transcription-architecture.md), [transcription-STATUS.md](./transcription-STATUS.md) — transcription feature docs (forward-looking; not wired into Phase 1)
