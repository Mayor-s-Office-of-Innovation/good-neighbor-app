# ADR 0001: Initial Architecture Stack

## Status

Accepted — **datastore choice superseded by [ADR 0002](0002-datastore-dynamodb.md)**
(managed Postgres + Prisma → single-table DynamoDB, 2026-08-13). The rest of the stack
stands.

## Context

The project is a CCSF SDLC Level 2 deployed system using AWS-managed services and a lightweight web frontend.

## Decision

Use AWS Lambda, API Gateway, SQS, Bedrock, Cognito, S3, CloudFront, WAF, managed Postgres, Prisma, Terraform, GitHub Actions, web components, Web Awesome, and Workbox.

> **Superseded (2026-08-13):** managed Postgres + Prisma were replaced by a single-table
> DynamoDB design accessed through the AWS SDK — see [ADR 0002](0002-datastore-dynamodb.md).
> The remaining stack choices are unchanged.

## Consequences

- The project avoids persistent server management.
- Infrastructure is auditable and repeatable through Terraform.
- Developers can operate through Git and CI without broad AWS console access.
- Offline capture requires idempotent backend APIs.
