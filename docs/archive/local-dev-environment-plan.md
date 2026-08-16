# Plan: Local Development Environment for the Lambda Backend

*DynamoDB planning set (doc 4 of 5) · [index](./README.md) · ← [analytics addendum](./analytics-plane-addendum.md) · next → [buildout plan](./dynamodb-buildout-plan.md)*

**Status:** Built & verified E2E (2026-08-13) — DynamoDB adopted; harness live under `npm run dev -w backend`
**Date:** 2026-08-12 (verified 2026-08-13)
**Depends on:** [dynamodb-database-decision.md](./dynamodb-database-decision.md). This plan
describes the **Docker-free** path, which is unlocked *by* adopting DynamoDB — the decided
direction (see [ADR 0002](./adr/0002-datastore-dynamodb.md)). The now-moot Postgres alternative
is kept for the record in [Fork: if we stay on Postgres](#fork-if-we-stay-on-postgres) at the
end (the shape is the same but a container / local Postgres install would have come back).

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

**Verified 2026-08-13** against JRE 17+ (Temurin 25 LTS): (1) `npm run dev -w backend` brought
up DynamoDB Local + ElasticMQ + router + worker Docker-free; (2) `GET /health`→200, unknown
route→404 match the deployed handlers; (3) `POST /submissions` flowed curl → SQS → worker →
DynamoDB Local, writing `SUBMISSION#t1 / #RECEIPT` (`status=received`, stub `sub`=`dev`), and a
same-key re-POST flipped it to `duplicate_replay` (conditional-Put replay branch); (4) `npm test`
(incl. the `buildProxyEvent` unit test) passes; (5) holds by construction. Clean SIGINT teardown
left no orphaned JVM/node processes. S3/MinIO remains deferred (handlers don't touch S3 yet).

## Alternatives considered (and why not)

Recorded so we don't relitigate. All three are good tools; each lost on a specific point.

- **Architect (arc.codes).** Excellent DX — its Sandbox (DynamoDB Local + an in-process event
  router) is the experience we're deliberately rebuilding here. Rejected as our tooling because
  it owns its **own infrastructure manifest** (`app.arc` → CloudFormation), a second source of
  truth competing with Terraform. We reuse its *ideas*, not its infra ownership.
- **AWS SAM CLI** (`sam local start-api --hook-name terraform`). Can read our Terraform and runs
  the real Lambda runtime — but it's **Docker-required**. Worth revisiting only if we ever want
  container-fidelity local API Gateway.
- **LocalStack + `tflocal`.** Highest fidelity — applies the *real Terraform* locally — but
  **Docker-required**, and Cognito (our authorizer) is Pro-tier. This was the original Layer 2
  before the Docker-free constraint.

**Chosen:** standalone emulators (DynamoDB Local / ElasticMQ) + an in-process router, with
infra-wiring validation moved to the cloud dev account (Phase 10). The trade is explicit —
**"Docker-free" and "run the real Terraform locally" are mutually exclusive today**, and we
picked Docker-free, which aligns with the architecture standard's "validate in a cloud env."

### The turnkey "arc-equivalent" local runtimes (compared 2026-08-13)

The original comparison above weighed Architect/SAM/LocalStack as *infra tools*. It never
compared the class of **turnkey local runtimes** that give the in-process "run my handlers
behind a local event router" experience — the thing that made Architect's Sandbox appealing.
Doing that now, so the choice to **hand-roll a thin router** (rather than adopt one) is on the
record:

| Tool | The Sandbox-style experience | Why not adopted |
|---|---|---|
| **Architect Sandbox** (`@architect/sandbox`) | Gold standard — in-process router + DynamoDB Local, no Docker | Coupled to an `app.arc` manifest → a second source of truth competing with Terraform |
| **Serverless Framework + `serverless-offline`** (+ `-sqs`, + `serverless-dynamodb`) | Closest turnkey match to *our* stack (HTTP API v2 + JWT-authorizer stub + SQS→Lambda + DynamoDB Local); one command | Needs a **dev-only `serverless.yml`** (competing manifest); 3 plugins of varying maintenance; **still launches the same JVM jars underneath** — it wraps the JVM, doesn't remove it |
| **SST** (`sst dev` Live Lambda) | Excellent DX | Not a local emulator — proxies to *real* AWS Lambda; needs an account + its own CDK/Pulumi config; not Terraform |

**Finding:** every turnkey arc-equivalent either owns a competing IaC manifest (Architect,
Serverless, SST) or needs Docker (SAM, LocalStack), and **none removes the JVM**. So the real
fork was *turnkey-framework-with-a-second-manifest* vs *thin-code-we-own*. We chose the
hand-rolled router (~150 lines over the real handlers): no manifest lock-in, Terraform stays
the single source of truth, and the only thing to keep in step is the route table.

### As-built specifics (verified 2026-08-13)

- **DynamoDB Local** via the `dynamodb-local` npm package (0.0.38), launched with **`-sharedDb`**
  (without it, data is partitioned by access-key+region and bootstrap/handlers can diverge).
  **Requires JRE 17+** (DynamoDB Local 2.x) — not just "a JVM".
- **ElasticMQ** has no maintained npm server helper; the harness downloads the official fat jar
  (`elasticmq-server-all-1.7.1.jar`) into git-ignored `backend/.local/` on first run and spawns
  `java -jar`. Bound to `127.0.0.1` (a small `backend/elasticmq.conf`) to avoid the macOS
  firewall prompt.
- **SDK redirection is env-only** (no `backend/src` change): `AWS_ENDPOINT_URL_DYNAMODB` /
  `AWS_ENDPOINT_URL_SQS` (service-specific beats the global `AWS_ENDPOINT_URL`), plus
  `AWS_REGION` and dummy credentials (v3 throws without them, even against local jars).
- **Env loading** uses Node 22's native `--env-file=.env.local` (no `dotenv` dep). Copy
  `.env.example` → `.env.local` once.

## Fork: if we stay on Postgres

> **Superseded (2026-08-13):** DynamoDB was adopted (see
> [ADR 0002](./adr/0002-datastore-dynamodb.md)), so this fork did **not** happen. Kept as an
> alternative-considered record.

Had the DynamoDB decision **not** landed, this plan would still apply with two changes, and
Docker (or a local Postgres install) would come back:

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
