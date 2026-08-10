# ADR 0001: Initial Architecture Stack

## Status

Accepted

## Context

The project is a CCSF SDLC Level 2 deployed system using AWS-managed services and a lightweight web frontend.

## Decision

Use AWS Lambda, API Gateway, SQS, Bedrock, Cognito, S3, CloudFront, WAF, managed Postgres, Prisma, Terraform, GitHub Actions, web components, Web Awesome, and Workbox.

## Consequences

- The project avoids persistent server management.
- Infrastructure is auditable and repeatable through Terraform.
- Developers can operate through Git and CI without broad AWS console access.
- Offline capture requires idempotent backend APIs.
