# ADR 0006: Docker-free Local Dev Harness

## Status

Accepted (2026-08-13). Enabled by [ADR 0002](0002-datastore-dynamodb.md) (DynamoDB removes the
need for a containerized Postgres); the local S3 slice is detailed in
[ADR 0003](0003-local-s3-minio.md).

## Context

We want to run the **exact code we deploy to Lambda** locally, with all real infrastructure
defined in code and Terraform as the single source of truth. Adopting DynamoDB removed the one
component (Postgres) that would otherwise have pulled a container or local DB install back in,
so a Docker-free loop became possible. The split is deliberate: the local harness answers *"does
my handler work"*; the cloud dev env (Terraform in CI) answers *"is it wired right"* (API
Gateway mappings, IAM, the SQS→Lambda event source).

## Decision

Run the backend against **standalone, Docker-free emulators**: DynamoDB Local and ElasticMQ as
JVM jars, MinIO as a single binary, an **in-process HTTP router** that builds an
`APIGatewayProxyEventV2` and calls `handler(event)` directly, and an in-process poll-and-invoke
worker. Emulators are reached through the same AWS SDK clients via endpoint env vars; the JWT
authorizer is stubbed and Bedrock is mocked (real calls only in the cloud dev env). Launched by
`npm run dev -w backend`; binaries download to git-ignored `backend/.local/` on first run. The
only runtime prerequisites are Node and a JVM.

## Consequences

- No Docker dependency; scales-to-zero local iteration with no credentials or network required.
- The harness is a **throwaway dev tool, not a deploy path** — its small amount of local
  "wiring" never competes with Terraform as the source of truth for real infrastructure.
- Handler logic and data access are exercised locally; API Gateway/IAM/event-source wiring is
  *not* — that is verified only in the Terraform-provisioned cloud dev env.
- First run pays one-time binary downloads (JVM jars + ~103 MB MinIO) into `backend/.local/`.

## Addendum — e2e table isolation (2026-10-14)

The e2e suite previously ran against the same DynamoDB Local table a developer's
`npm run dev` uses (`gnp-local-app`, one `-sharedDb` instance), and globalSetup
deleted every `TASK#` item for rerun hygiene — which silently wiped developer
data when the host table held real work. Two changes close that:

- **The suite owns its table.** `playwright.config.js` pins
  `DYNAMO_TABLE=gnp-local-e2e` for the spawned backend: `ensureLocalInfra()`
  creates + seeds it at boot through the same code path as the dev table (one
  source of truth for schema and seed), and globalSetup/globalTeardown guard on
  the same name. globalSetup **refuses to run** against any other table.
- **The suite never reuses running servers.** `reuseExistingServer: false` — a
  dev-started backend carries the dev table's env, so attaching to it would
  defeat the isolation. (Superseded 2026-10-28: the suite now moves to free
  ports instead of failing — see the addendum below.)
- **globalTeardown deletes `gnp-local-e2e`** after the run (the suite's table is
  disposable). The next boot re-creates + reseeds it, so checks and tasks are
  always coherent; globalSetup's entry cleanup remains as crash self-healing.

Developer-facing consequence: `npm run dev` data is never touched by the suite,
and a clean dev table is `rm -rf backend/.local/dynamodb-data` (optionally
`minio-data` too) with the stack stopped, since the next dev boot re-bootstraps.

## Addendum — e2e beside `npm run dev` (2026-10-28)

The e2e suite can run while a dev stack is up:

- **Its servers move instead of clashing.** The e2e configs pick the next free
  port when the usual one is taken (`e2e/helpers/ports.mjs`) for the API, the
  analyzer stub and Vite, and point the spawned backend and Vite proxy at them.
- **Shared services are reused.** DynamoDB Local and ElasticMQ, like MinIO and
  the SF311 fake already did, reuse a copy that is already answering on their
  port instead of crashing the stack. The suite still keeps to its own table
  (`gnp-local-e2e-<runId>`) and matching submission queue, so dev data and
  other runs are untouched. A UUID is generated once per invocation and inherited
  by workers; setup and teardown validate the exact names before mutation.
  Teardown removes both resources. A hard-killed run can leave its namespaced
  resources behind; a later run does not reuse or delete them.
- Stopping the dev stack while the suite runs takes the shared services with
  it. The borrowing lanes check every 3 s and stop the suite's backend when the
  service is gone; globalSetup watches that backend and, when it stops
  answering, prints why and interrupts the run (like Ctrl+C), so it ends in
  seconds instead of failing test by test. Let the suite finish first.

- Pinned ports are validated and cannot overlap another server selected by the
  same config process. Cross-process probe-to-bind races remain a known limitation:
  simultaneous starts can still fail to bind; the suite never attaches to a foreign server.
- Shared-service startup probes retry inconclusive timeouts for a bounded period.
  Backend-watch cleanup aborts its active probe and prevents late interruption
  of a completed run.
