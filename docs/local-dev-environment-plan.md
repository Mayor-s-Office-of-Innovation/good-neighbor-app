# Plan: Local Development Environment for the Lambda Backend

**Status:** Proposed — runnable plan, pending the database decision
**Date:** 2026-08-12
**Depends on:** [dynamodb-database-decision.md](./dynamodb-database-decision.md). This plan
describes the **Docker-free** path, which is unlocked *by* adopting DynamoDB. If the team
keeps Postgres, see [Fork: if we stay on Postgres](#fork-if-we-stay-on-postgres) at the end —
the shape is the same but a container (or local Postgres install) comes back.

## Goal

Run the **exact code we deploy to Lambda**, locally, with **all architecture defined in
code and no click-ops** — while keeping Terraform as the single source of truth for real
infrastructure.

We meet the two requirements as a deliberate split:

- **Local (this plan):** exercises our handler code and data-access logic against
  standalone, Docker-free emulators. Answers *"does my handler work."*
- **Cloud dev env (Terraform in CI):** exercises API Gateway mappings, IAM, the SQS→Lambda
  event source, and DynamoDB IAM policies. Answers *"is it wired right."* (Phase 8.)

The local harness is a **throwaway dev tool, not a deploy path** — so the small amount of
local "wiring" it defines never competes with Terraform as the source of truth.

## Production → local component map

| Production | Local (Docker-free) | Runtime dep |
|---|---|---|
| Lambda + API Gateway (HTTP v2) | in-process HTTP router that builds an `APIGatewayProxyEventV2` and calls `handler(event)` | Node |
| SQS + event source mapping | **ElasticMQ** (SQS-compatible) + a poll-and-invoke pump | JVM |
| DynamoDB | **DynamoDB Local** | JVM |
| S3 (uploads) — *not used by handlers yet* | **MinIO** (single binary) or `s3rver` | — / Node |
| Cognito JWT authorizer | stubbed authorizer claims (see Phase 4) | — |
| Bedrock | mocked in tests; real calls only in cloud dev env | — |

**Prerequisites:** Node (already required) and a **JVM** (DynamoDB Local and ElasticMQ ship
as Java jars). This is the one non-Node prerequisite of the Docker-free path — worth stating
plainly so nobody expects zero dependencies.

---

## Phase 0 — Config seam (no new services yet)

**Why first:** everything downstream keys off a clean local/prod switch, and our code is
already 90% there.

- SDK v3 clients (`new SQSClient({})`) auto-read `AWS_ENDPOINT_URL` / `AWS_ENDPOINT_URL_SQS`
  — no code change needed to redirect them locally.
- Extend [config.js](../backend/src/config.js) to carry a `dynamoTable` (and later
  `uploadBucket` already exists) so the DynamoDB Document Client and handlers read the table
  name from env.
- Add a local env file (e.g. `.env.local`, git-ignored) with the local endpoints, queue URL,
  table name, and a fake `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (the jars accept
  anything). Mirror the keys in `.env.example`.

**Done when:** `getConfig()` returns local values from `.env.local` and the app can be
pointed at local endpoints purely through env vars.

## Phase 1 — Stand up the local services

Add as dev dependencies / vendored jars and expose each as an npm script:

- **DynamoDB Local** — via the `dynamodb-local` npm helper (downloads the jar) or a vendored
  jar; listen on `:8000`.
- **ElasticMQ** — vendored jar or `elasticmq` helper; listen on `:9324`, SQS-compatible.
- **MinIO / `s3rver`** — *optional for now*; handlers don't touch S3 yet. Defer until the
  uploads feature lands, then add on `:9000`.

**Done when:** each service starts from an npm script and responds on its port (a quick
`aws --endpoint-url` CLI call against each confirms it).

## Phase 2 — Resource bootstrap (create local infra in code)

A single idempotent Node script (`scripts/local-bootstrap.mjs`) that, on startup:

- creates the DynamoDB table(s) with the same key schema/indexes we'll define in Terraform,
- creates the ElasticMQ queue matching `SQS_QUEUE_URL`,
- (later) creates the MinIO/`s3rver` bucket.

Keep the table definition **derived from the same shape** as the Terraform
`aws_dynamodb_table` so local and prod don't drift. This script is the local analogue of
`terraform apply` — code, not click-ops.

**Done when:** running the script against fresh services produces the table + queue, and
re-running is a no-op.

## Phase 3 — In-process HTTP router (API Gateway emulation)

A small Node HTTP server (`scripts/local-api.mjs`) that:

- maps method+path → the matching handler module (the same routes we'll define in Terraform's
  API Gateway),
- constructs a realistic `APIGatewayProxyEventV2` (headers, body, `isBase64Encoded`,
  `requestContext`),
- calls the **real exported `handler`** and writes its `statusCode`/`headers`/`body` back.

This is the arc.codes Sandbox experience rebuilt on our own code — a thing you can `curl`.

**Done when:** `curl -X POST localhost:3000/submissions` with an `idempotency-key` header
returns the `202 { status: "queued" }` from [submissions.js](../backend/src/handlers/submissions.js)
and a message lands in ElasticMQ.

## Phase 4 — Auth stub (Cognito authorizer)

The submissions handler reads `event.requestContext.authorizer.jwt.claims.sub`. Locally, the
router injects a configurable fake `sub` (e.g. from an `X-Debug-Sub` header or an env
default) so there's no Cognito emulation and no Docker/Pro license. Real JWT validation
happens only in the cloud dev env.

> **Open decision (from the DB doc's Cognito thread):** default to the stub. Revisit only if
> we decide we need true token flows locally.

**Done when:** requests carry a stubbed `sub` and the handler's auth branch behaves like prod.

## Phase 5 — SQS → worker pump (event source emulation)

A small poller (`scripts/local-worker.mjs`) that long-polls ElasticMQ, wraps received
messages in an `SQSEvent` shape, and invokes the **real** worker
[process-submission.js](../backend/src/workers/process-submission.js) `handler`, then
deletes on success. This stands in for the Lambda event source mapping.

**Done when:** a message produced in Phase 3 is picked up, the worker writes the item to
DynamoDB Local, and it's visible in the GUI (Phase 6).

## Phase 6 — Data browsing GUI

- **`dynamodb-admin`** as a dev dependency + npm script (`db:gui`):
  `DYNAMO_ENDPOINT=http://localhost:8000 dynamodb-admin` → browse at `:8001`.
- **NoSQL Workbench** (AWS desktop app) documented for table-design work, not scripted.

**Done when:** `npm run db:gui` opens a browser view of the local table and its items.

## Phase 7 — One-command orchestration

Wire it together with `concurrently` (or `npm-run-all`) behind a single script:

```jsonc
// package.json (illustrative)
"scripts": {
  "local:services": "concurrently -n ddb,sqs \"npm:local:ddb\" \"npm:local:sqs\"",
  "local:bootstrap": "node scripts/local-bootstrap.mjs",
  "local:api": "node scripts/local-api.mjs",
  "local:worker": "node scripts/local-worker.mjs",
  "db:gui": "dynamodb-admin",
  "dev": "concurrently -n svc,api,worker \"npm:local:services\" \"npm:local:api\" \"npm:local:worker\""
}
```

Startup order: services → bootstrap (once healthy) → api + worker.

**Done when:** `npm run dev` (after a one-time `local:bootstrap`) gives a working end-to-end
loop: `curl` → SQS → worker → DynamoDB → visible in the GUI.

## Phase 8 — Seed data (optional but recommended)

A `scripts/local-seed.mjs` that writes a few representative items via the Document Client so
the app has data on a fresh start. Keep seeds in code, checked into Git.

## Phase 9 — Tests: the real fast inner loop

The daily loop is **direct handler invocation**, not the HTTP router:

- Use the Node built-in test runner (or the existing test setup) to import each `handler` and
  call it with typed synthetic events — our JSDoc `APIGatewayProxyHandlerV2WithJWTAuthorizer`
  / `SQSHandler` types make the event shapes exact.
- Point AWS clients at the local services (or use `aws-sdk-client-mock` for pure unit tests).
- Mock Bedrock.

This runs the exact code we deploy, sub-second, and is what CI runs.

**Done when:** `npm test` exercises the submissions handler and the worker against DynamoDB
Local / ElasticMQ and passes.

## Phase 10 — Cloud dev env validates the wiring (Terraform in CI)

The local harness intentionally does **not** test API Gateway routing, IAM, or the real
event source mapping. Those are validated by applying the **real Terraform** to a dev account
via CI (per the architecture standard: "target a cloud environment from the first commit,"
"Terraform runs in CI"). No new local Terraform.

**Done when:** a CI pipeline plans/applies the Terraform to a dev environment and a smoke
test hits the real API Gateway endpoint.

---

## Acceptance criteria (whole plan)

1. `npm run dev` brings up a Docker-free, end-to-end local backend.
2. `curl` against the local API produces the same responses as the deployed handlers.
3. A submission flows curl → SQS → worker → DynamoDB and is browsable in `dynamodb-admin`.
4. `npm test` runs the exact handler code against local services and passes.
5. No click-ops anywhere: local resources are created by `local-bootstrap.mjs`, real
   resources by Terraform.

## Fork: if we stay on Postgres

If the DynamoDB decision does **not** land, this plan still applies with two changes, and
Docker (or a local Postgres install) comes back:

- **Datastore:** run Postgres locally (Docker Compose or a native install); keep Prisma.
  Phase 2 becomes `prisma migrate`/`prisma db push` instead of a DynamoDB table create.
- **Emulator choice:** with a container already required for Postgres, **LocalStack +
  `tflocal`** becomes attractive again — it would let Phases 1–5 apply the *real Terraform*
  locally instead of using the in-process router, buying more fidelity at the cost of Docker.
- **GUI:** use a Postgres client (psql, TablePlus, DataGrip) instead of `dynamodb-admin`.

## Open items

- Finalize the DynamoDB table model (single-table vs per-entity) — open question #3 in the
  DB decision doc; use NoSQL Workbench.
- Decide whether S3/MinIO is needed in the initial harness or deferred until uploads land.
- Confirm the auth stub is sufficient, or whether local token flows are wanted later.
