# Docs index

## Database direction & local dev (planning set, Aug 2026)

These five docs form one thread: the decision to move from Postgres/Prisma to **DynamoDB**,
the data model, city-wide reporting, how to run the backend locally, and how to build it all.
All are **Proposed** — pending team sign-off and three open decisions (metric formulas, city
cross-site queue, retention). **Read them in this order:**

1. **[dynamodb-database-decision.md](./dynamodb-database-decision.md)** — *start here.* Why
   DynamoDB over Postgres, the ripple effects, and the honest Postgres fork. The "should we?"
2. **[dynamodb-data-model.md](./dynamodb-data-model.md)** — the single-table model, access
   patterns, GSIs, tenant isolation, and the identity model (device-as-site). The "how it's
   shaped."
3. **[analytics-plane-addendum.md](./analytics-plane-addendum.md)** — city-wide reporting:
   Tier 1 live counters + Tier 2 (S3-export → Athena), with complexity and cost (~$5–15/mo).
   Extends doc 2. The "how reporting works."
4. **[local-dev-environment-plan.md](./local-dev-environment-plan.md)** — the Docker-free local
   harness (DynamoDB Local / ElasticMQ), plus *Alternatives considered* (why not Architect /
   SAM / LocalStack). The "how we run it locally."
5. **[dynamodb-buildout-plan.md](./dynamodb-buildout-plan.md)** — *capstone.* The phased
   Terraform + code build plan (table → app cutover → analytics), sequenced to a queryable
   Athena prototype. References docs 1–4. The "how we build it."

**Just want the decision?** Read 1. **Deciding in a meeting?** 1 → 2 → 3, then the open
decisions consolidated in 5's Phase 0. **Building it?** 5, referring back as needed.

## Other docs in this directory

- [architecture.md](./architecture.md), [adr/](./adr/) — architecture notes and decision records
- [sdlc-level-2-checklist.md](./sdlc-level-2-checklist.md), [security-review.md](./security-review.md) — SDLC / security process
- [js-and-jsdoc-migration-plan.md](./js-and-jsdoc-migration-plan.md), [gnp-frontend-migration-plan.md](./gnp-frontend-migration-plan.md) — the in-progress JS/JSDoc and frontend migrations
- [transcription-architecture.md](./transcription-architecture.md), [transcription-STATUS.md](./transcription-STATUS.md) — transcription feature docs
