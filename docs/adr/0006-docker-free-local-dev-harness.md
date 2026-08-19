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
