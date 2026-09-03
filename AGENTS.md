# Agent Instructions

This repo follows the CCSF Software Development Lifecycle Standard for a Level 2 deployed system.

## Orientation — read order

New here? Get your bearings in this order:

1. **This file (AGENTS.md)** — standing choices, SDLC rules, and current state (below).
2. **[docs/README.md](docs/README.md)** — the reference-docs map: architecture, data model,
   ADRs, runbooks. Go here to find the authoritative doc for the area you're in.
3. **The GitHub issue tracker** — all open plans, tasks, and in-flight work. Docs in this
   repo are perpetually useful references, not trackers; anything time-bound lives in issues.

## Current state

- **Stack & datastore are settled:** JavaScript + JSDoc backend and frontend
  ([ADR 0004](./docs/adr/0004-javascript-with-jsdoc.md)), single-table DynamoDB
  ([ADR 0002](./docs/adr/0002-datastore-dynamodb.md)), 2-env deploy pipeline
  ([ADR 0007](./docs/adr/0007-deploy-promotion-model.md)) — dev live-proven, prod pending
  first release-deploy (issue tracker).
- **Built and live in the repo:** the perimeter-check → analyzer → guidance-workflow
  pipeline (see [docs/architecture.md](./docs/architecture.md)), error tracking
  ([ADR 0008](./docs/adr/0008-lean-client-error-capture.md); rollout completion tracked as
  an issue), and the Docker-free local harness ([ADR 0006](./docs/adr/0006-docker-free-local-dev-harness.md)).
- **Deferred for the MVP: all offline / service worker.** No SW ships yet; the "Use Workbox
  for offline capture and sync" standing choice below is on hold until a dedicated post-MVP
  offline pass (tracked on the issue tracker).
- Live transcription was dropped (2026-09-02) — keyboard dictation covers the need; see
  [ADR 0009](./docs/adr/0009-drop-transcription.md).

## Standing Project Choices

- Write application code in JavaScript (ES modules), not TypeScript. Get type safety
  without a transpile step by type-checking `.js` files with the TypeScript compiler in
  `checkJs` mode, expressing types in JSDoc. `tsc --noEmit` (run as `npm run typecheck`
  in CI) is the type gate; source runs unmodified in the browser and on Lambda. See
  [ADR 0004](./docs/adr/0004-javascript-with-jsdoc.md).
- Use native web components for UI and Web Awesome for shared UI primitives.
- Use Workbox for offline capture and sync.
- Use AWS Lambda, API Gateway, SQS, Bedrock, Cognito, S3, CloudFront, WAF, and DynamoDB.
- Use a single-table DynamoDB design accessed through the AWS SDK (`@aws-sdk/lib-dynamodb`
  Document Client); schema/indexes are defined in Terraform. See
  [docs/dynamodb-data-model.md](./docs/dynamodb-data-model.md).
- Use Terraform for all infrastructure and GitHub Actions for CI/CD.

## SDLC Rules

- Keep application code, infrastructure, CI/CD, docs, and configuration in Git.
- Do not add secrets to source control. Use AWS Secrets Manager or SSM Parameter Store references.
- Terraform state must use a remote backend with S3 versioning and DynamoDB locking.
- Terraform plan/apply runs in CI, not from developer laptops.
- Every cloud resource must include required CCSF tags:
  `Application`, `ApplicationOwner`, `Environment`, `DataClassification`,
  `InternetExposure`, `AssetCriticality`, and `Compliance`.
- Prefer managed services and least-privilege IAM.
- Public-facing web surfaces must use TLS 1.2 minimum, HSTS, CSP, secure headers, CAA records, CloudFront, WAF, and rate limits.
- Pin GitHub Actions to immutable commit SHAs when productionizing workflows. This starter uses named versions for readability and should be pinned before go-live.

## Skills

Project-local skills are vendored under `.claude/skills` from:

- `Mayor-s-Office-of-Innovation/skills/dashboard-review`
- `Mayor-s-Office-of-Innovation/skills/web-dev`

Use the `web-dev` skill for frontend work. User architecture overrides the skill defaults where they differ: this project uses AWS hosting instead of GitHub Pages (the DynamoDB datastore now matches the skill default).

Use the `dashboard-review` skill only after dashboards or data visualizations exist and need source, denominator, tone, and clarity review.
