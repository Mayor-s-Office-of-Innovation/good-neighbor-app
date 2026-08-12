# Agent Instructions

This repo follows the CCSF Software Development Lifecycle Standard for a Level 2 deployed system.

## Orientation — read order

New here? Get your bearings in this order:

1. **This file (AGENTS.md)** — standing choices, SDLC rules, and what's in flight (below).
2. **[docs/README.md](docs/README.md)** — the docs map: every planning thread with its own
   ordered read path and status. Go here to find the right doc for the area you're in.
3. **The thread you're working in** — follow the order `docs/README.md` gives for that area
   (frontend migration, database direction, transcription, …), then the file-level detail.

## Active Plans

Migration is in progress; read the linked plans before following the standing choices below
— some of those choices are being revised.

- **Frontend migration (JS+JSDoc, then `gnp` adoption): Steps 1 & 2 DONE (2026-08-12).** The
  backend is JavaScript + JSDoc with the `typecheck` gate in CI, and the `gnp` prototype is
  now the `frontend/` — built and green under a lenient `checkJs` gate. See
  [docs/js-and-jsdoc-migration-plan.md](docs/js-and-jsdoc-migration-plan.md) (Step 1) and
  [docs/gnp-frontend-migration-plan.md](docs/gnp-frontend-migration-plan.md) (Step 2 — still
  the tracker for the open backend/auth/deploy decisions D1–D4 and I1).
- **Deferred for the MVP: all offline / service worker.** No SW ships yet; the "Use Workbox
  for offline capture and sync" standing choice below is on hold until a dedicated post-MVP
  offline pass (details in the Step 2 doc).
- **Parked: DynamoDB vs managed Postgres.** An active planning thread may reverse the
  Postgres/Prisma standing choice below; see the database thread in
  [docs/README.md](docs/README.md).

## Standing Project Choices

- Write application code in JavaScript (ES modules), not TypeScript. Get type safety
  without a transpile step by type-checking `.js` files with the TypeScript compiler in
  `checkJs` mode, expressing types in JSDoc. `tsc --noEmit` (run as `npm run typecheck`
  in CI) is the type gate; source runs unmodified in the browser and on Lambda. See
  [docs/js-and-jsdoc-migration-plan.md](docs/js-and-jsdoc-migration-plan.md). (Both backend
  and frontend are now migrated to JS+JSDoc — see Active Plans above.)
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
