# Database Decision: DynamoDB instead of Postgres

*DynamoDB planning set (doc 1 of 5) · [index & read order](./README.md) · next → [data model](./dynamodb-data-model.md)*

**Status:** Proposed — for team discussion / buy-in
**Date:** 2026-08-12
**Affects:** [AGENTS.md](../AGENTS.md) standing choices (Prisma, managed Postgres), the
JS/JSDoc and frontend migration plans, and the local development story.

## TL;DR

We are considering replacing managed Postgres (via Prisma) with **DynamoDB** as the
primary datastore. The switch is low-cost right now, fits our existing data model and
serverless architecture well, and unlocks a Docker-free, arc.codes-style local development
loop. The main thing to get right before committing is whether **reporting/analytics** is
on the near-term roadmap, since that is DynamoDB's classic weak spot.

## Why now is the cheap moment to decide

- **RDS is not in our Terraform yet.** The infra module defines KMS, S3, SQS, Cognito,
  CloudFront, and WAF — but no `aws_db_instance`/RDS. Only the Prisma schema and `db.js`
  exist. Switching to DynamoDB costs us **zero rewritten infrastructure**; we add
  `aws_dynamodb_table` instead of ever writing the RDS + VPC + subnet-group + RDS-Proxy
  stack we don't have yet.
- **Our data model is already a DynamoDB item.** `schema.prisma` is a single entity,
  `id`-keyed, with a JSON `payload` and a `status`; `workers/process-submission.js` does an
  idempotent upsert keyed by `requestId`. That is the canonical DynamoDB access pattern (a
  conditional `PutItem`). We are not bending the model to fit — it already fits.

## Architecture ripple effects (mostly in our favor)

- **No VPC. No RDS Proxy. No connection pooling.** This is the big one. Postgres-from-Lambda
  almost always means putting Lambdas in a VPC and adding RDS Proxy to survive connection
  storms. DynamoDB is called over the AWS API with IAM auth — Lambdas stay *out* of the VPC,
  cold starts stay low, and a whole class of infrastructure (subnet groups, NAT, proxy)
  never gets written. For a serverless architecture this is the natural fit; Postgres is the
  thing we were about to fight.
- **Scales to zero, pay-per-request.** On-demand DynamoDB has no idle cost — right for a
  civic app with spiky/low traffic. RDS bills 24/7.
- **Prisma goes away** (standing-choice change). Prisma is relational; there is no
  first-class DynamoDB provider. We would use `@aws-sdk/lib-dynamodb` (the Document Client).
  Schema and indexes live in Terraform (`aws_dynamodb_table`), not in migrations — the
  offline/idempotency design (Workbox sync + `idempotency-key`) maps cleanly to conditional
  writes.

## The caveat we must not skip

DynamoDB rewards knowing your access patterns up front and punishes ad-hoc queries, joins,
and reporting. We have a `dashboard-review` skill vendored and this is a civic-data app — if
Good Neighbor grows toward *"show me submissions grouped by neighborhood over time"* style
reporting, that is DynamoDB's classic pain point. The usual answer is fine (stream to
S3/Athena, or a read replica for analytics), but we should decide now whether reporting is a
near-term need.

- For the **transactional** offline-submission path we've built, DynamoDB is arguably the
  better choice.
- For **analytics-heavy** futures, Postgres earns its keep.

## Why this unlocks a Docker-free local development loop

We originally reached for LocalStack (which is Docker-only, as is AWS SAM local) largely
*because* Postgres forced a container and we needed something for SQS/S3 too. Drop Postgres
and every remaining stateful dependency has a **standalone binary/JVM emulator** — no Docker
daemon anywhere:

| Service | Docker-free local emulator | Notes |
|---|---|---|
| DynamoDB | **DynamoDB Local** (Java jar / `dynamodb-local` npm) | This is literally what arc.codes Sandbox runs under the hood — the experience we loved |
| SQS | **ElasticMQ** (single jar, SQS-compatible API) | Point `AWS_ENDPOINT_URL_SQS` at it |
| S3 | **MinIO** (single Go binary) or `s3rver` (node) | S3-compatible |
| Lambda + API Gateway | *in-process HTTP router* | Not emulated — we call the handler directly |

The last row is the key insight: without Docker we don't *emulate* Lambda/API Gateway, we
replace them with a small in-process HTTP server that builds an `APIGatewayProxyEventV2` and
calls `handler(event)`. That is exactly what arc.codes Sandbox does — an in-process event
router over DynamoDB Local. So going DynamoDB doesn't just permit a Docker-free stack; it
lets us rebuild the specific arc.codes experience we enjoyed, on top of our own
Terraform-defined architecture.

Our code is already wired for this: SDK v3 clients (`new SQSClient({})`) auto-read
`AWS_ENDPOINT_URL`, and `config.js` already externalizes `queueUrl`/`uploadBucket`. The seam
exists; we'd add a `dynamoTable` to it.

### Browsing local data (there is a real GUI story)

A common unknown with arc.codes was whether you could *see* your local data. You can — arc's
Sandbox ran DynamoDB Local as a plain HTTP endpoint (default `:8000`), and any Dynamo GUI
that accepts a custom endpoint URL points straight at it. The same applies to our harness. Two
complementary tools:

- **`dynamodb-admin` — the daily browse-the-data tool.** A single npm dev-dependency, browser
  GUI, zero Docker. De-facto companion to DynamoDB Local. Add it as an npm script:

  ```bash
  DYNAMO_ENDPOINT=http://localhost:8000 npx dynamodb-admin
  # open http://localhost:8001
  ```

  Browse tables, scan/query items, edit/delete rows, create tables. Fits the Docker-free
  story perfectly. This is the piece that was always available under arc.codes too — it just
  had to be wired up.

- **NoSQL Workbench (AWS official desktop app) — the table-design tool.** Heavier (Electron
  desktop app), but it connects to DynamoDB Local *and* doubles as an access-pattern data
  modeler and visual query builder. This is the tool we'd actually use to design and
  pressure-test open question #3 (single-table vs per-entity) before writing the Terraform.
  Free from AWS.

They're complementary: `dynamodb-admin` answers *"what's in my local table right now,"*
NoSQL Workbench answers *"how should this table be shaped."* (Dynobase is a polished paid
alternative if the team wants nicer ergonomics, but it isn't needed.)

### The one honest tradeoff that comes with Docker-free

**"Docker-free" and "run my real Terraform locally" are mutually exclusive today.** The whole
value of a LocalStack-based local stack was `tflocal apply` of our *actual* `.tf` files —
testing infra wiring from the single source of truth. The in-process router is *not* our
Terraform; it's a small parallel definition of routes and queues for local only. That's the
same "second infra definition" smell we want to avoid — the difference is it's a throwaway
dev harness, not our deploy path, so the blast radius is small.

Infra-wiring correctness gets tested **in a real cloud dev account, via Terraform in CI** —
which is exactly what our architecture standard already mandates ("target a cloud environment
from the first commit," "Terraform runs in CI"). The consistent split:

- **Local (Docker-free):** our code + data-access logic, fast, against DynamoDB Local /
  ElasticMQ / MinIO. Answers *"does my handler work."*
- **Cloud dev env (real Terraform):** API Gateway mappings, IAM, the SQS→Lambda event source,
  DynamoDB IAM policies. Answers *"is it wired right."*

We lose local emulation of API Gateway/IAM — but our own standard says don't trust local for
that anyway. This isn't a compromise against our standards; it's *more* aligned with them.

## Standing-choice changes this implies

If we adopt DynamoDB, the following in [AGENTS.md](../AGENTS.md) change and should be updated
deliberately, not slipped in:

- "Use Prisma for schema and migrations" → **removed.** Access via `@aws-sdk/lib-dynamodb`;
  table/index definitions live in Terraform.
- "managed Postgres" in the AWS services list → **DynamoDB.**
- The JS/JSDoc and frontend migration plans reference Prisma/Postgres in passing and will
  need a pass.

## Open questions for the team

1. **Reporting/analytics** — is anything beyond key-value access (dashboards, cross-cutting
   queries) on the roadmap soon? This is the one thing that would make us reconsider
   DynamoDB. If yes, do we accept an analytics side-path (S3 + Athena, or CDC to a warehouse)
   rather than switching back to Postgres?
2. **Accepting the local/cloud split** — are we comfortable that local tests exercise code
   against standalone emulators while *infra wiring* is validated only in a real
   Terraform-driven dev account (no local Terraform)? That's the cost of Docker-free.
3. **Single-table vs per-entity tables** — a modeling decision to make once we enumerate
   access patterns beyond the current single `OfflineSubmission` entity.

## Recommendation

Adopt DynamoDB for the transactional path, provided reporting is not a near-term hard
requirement. It is cheaper to adopt now than ever, fits the data model and serverless
architecture, and gives us the Docker-free, arc.codes-style local loop we want.
