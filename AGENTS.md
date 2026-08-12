# Agent Instructions

This repo follows the CCSF Software Development Lifecycle Standard for a Level 2 deployed system.

## Active Plans

Migration is in progress. Read these before following the standing choices below —
some choices are being revised:

- [docs/js-and-jsdoc-migration-plan.md](docs/js-and-jsdoc-migration-plan.md) — replace
  TypeScript syntax with JavaScript + JSDoc (type safety via `tsc --checkJs`, no transpile).
  **Step 1 done: the backend is converted and the `typecheck` gate is in CI.** The
  frontend is still `.ts` scaffolding, converted wholesale in the next step.
- [docs/gnp-frontend-migration-plan.md](docs/gnp-frontend-migration-plan.md) — bring the
  `gnp` prototype in as the frontend (**next**); tracks every open item, decision, and status.

## Standing Project Choices

- Write application code in JavaScript (ES modules), not TypeScript. Get type safety
  without a transpile step by type-checking `.js` files with the TypeScript compiler in
  `checkJs` mode, expressing types in JSDoc. `tsc --noEmit` (run as `npm run typecheck`
  in CI) is the type gate; source runs unmodified in the browser and on Lambda. See
  [docs/js-and-jsdoc-migration-plan.md](docs/js-and-jsdoc-migration-plan.md). (Backend is
  migrated; the frontend is still `.ts` scaffolding pending the gnp adoption step.)
- Use native web components for UI and Web Awesome for shared UI primitives.
- Use Workbox for offline capture and sync.
- Use AWS Lambda, API Gateway, SQS, Bedrock, Cognito, S3, CloudFront, WAF, and managed Postgres.
- Use Prisma for schema and migrations.
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

Use the `web-dev` skill for frontend work. User architecture overrides the skill defaults where they differ: this project uses AWS hosting and Postgres/Prisma instead of GitHub Pages and DynamoDB.

Use the `dashboard-review` skill only after dashboards or data visualizations exist and need source, denominator, tone, and clarity review.
