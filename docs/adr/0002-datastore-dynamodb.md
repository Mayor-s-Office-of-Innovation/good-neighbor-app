# ADR 0002: Adopt DynamoDB as the Application Datastore

## Status

Accepted (2026-08-13). Supersedes the datastore choice in
[ADR 0001](0001-architecture-stack.md) (managed Postgres + Prisma).

## Context

ADR 0001 chose managed Postgres with Prisma. As the domain was modeled it became clear the
workload is a small number of tenant-isolated, time-ordered access patterns (~400 sites,
3 checks/day, all site-scoped and time-ordered) rather than relational joins. A single-table
DynamoDB design fits these patterns, enables tenant isolation in IAM (`dynamodb:LeadingKeys`
pinned to `SITE#<siteId>`) rather than in app code, and preserves a VPC-free, scales-to-zero
operational model with no connection-pooling (RDS Proxy) concerns for Lambda. Cross-site
analytical reporting is handled by a CQRS read plane (DynamoDB Streams → Tier-1 counters and
a Tier-2 S3/Athena lake) rather than the operational table.

The full analysis — including the honest Postgres fork — is in
[dynamodb-database-decision.md](../dynamodb-database-decision.md), validated against real
access patterns in [dynamodb-data-model.md](../dynamodb-data-model.md).

## Decision

Use a **single-table DynamoDB** design (`gnp-<env>-app`, partition key `pk`, sort key `sk`,
on-demand capacity, SSE-KMS, PITR + Streams on) accessed through the AWS SDK
(`@aws-sdk/lib-dynamodb` Document Client). Schema and GSIs are defined in Terraform. Prisma
and managed Postgres are removed.

## Consequences

- Tenant isolation is enforced at the platform layer via IAM `LeadingKeys`, not only in app
  code.
- No VPC, no RDS Proxy, no schema-migration tooling; table/index changes are Terraform.
- Cross-site OLAP reporting requires the CQRS read plane (Streams → Tier-1 counters + Tier-2
  S3/Athena), which is a first-class launch requirement rather than a relational `GROUP BY`.
- The offline idempotency design carries over: a client-generated ULID `checkId` is the
  idempotency key for a conditional (`attribute_not_exists`) write.
