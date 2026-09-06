# Docs index

> **Start here.** This is the map of the repo's reference docs. Plans, tasks, and anything
> time-bound live in the **GitHub issue tracker**, not here — these docs are accurate,
> perpetually useful references. Decision records live in [adr/](./adr/). If you're an agent
> getting your bearings, read [AGENTS.md](../AGENTS.md) first.

## Core reference

- **[architecture.md](./architecture.md)** — the built system: container view, async analyze
  flow, the guidance workflow (rule-driven tasks), single-table pointer, security boundaries,
  idempotency/offline posture.
- **[dynamodb-data-model.md](./dynamodb-data-model.md)** — the authoritative item shapes,
  keys, GSIs, access patterns, identity model, and metric definitions for the single-table
  store.
- **[ADR directory](./adr/)** — every significant decision and its "why" (numbered,
  immutable; superseded ADRs point forward). Start with
  [ADR 0001](./adr/0001-architecture-stack.md) → [ADR 0002](./adr/0002-datastore-dynamodb.md)
  for the stack + datastore story.
- **[ADR 0010](./adr/0010-device-token-auth.md)** — the device-token auth
  decision now wired into the API (amends the identity decision in
  [security-review.md](./security-review.md)).

## Operations

- **[dev-commands.md](./dev-commands.md)** — developer command reference (setup, CI checks,
  local harness).
- **[runbooks/](./runbooks/)** — operational runbooks (source of truth; the `~/dev/notes/`
  folder is plans + history, see AGENTS.md).

## Domain & policy reference

- **[guidance-policy-changelog.md](./guidance-policy-changelog.md)** — policy operations log
  for the action/escalation rulebase (versions, update process). The workflow itself is
  described in [architecture.md](./architecture.md); the rule catalog lives in
  `backend/src/analysis/guidance/`.
- **[frontend-design-system.md](./frontend-design-system.md)** — living reference for
  building a screen to spec from the token/class system (`tokens.css` / `app.css` are the
  source of truth).

## Process & security

- **[sdlc-level-2-checklist.md](./sdlc-level-2-checklist.md)** — the CCSF SDLC standard,
  Level 2, as a checklist.
- **[security-review.md](./security-review.md)** — the written security review: threat model,
  auth postures (demo deterrence-grade vs Option 3 real), hardening checklist, and the
  pre-launch TODOs.

## ADRs — `adr/`

**A**rchitecture **D**ecision **R**ecords: short, numbered, immutable notes capturing a
significant architecture decision, its context, and the alternatives weighed — one file per
decision (`NNNN-title.md`). They're the durable "why" behind the current design. We **supersede,
never rewrite or delete**: a decision that changes gets a new ADR, and the old one's Status is
marked superseded with a pointer forward (see [ADR 0001](./adr/0001-architecture-stack.md) →
[ADR 0002](./adr/0002-datastore-dynamodb.md), the Postgres/Prisma → DynamoDB pivot).