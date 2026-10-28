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

- **Duplicate detection is an experiment, not a deployed feature:** an image-first matcher,
  evaluation runner, and isolated shadow infrastructure exist locally; the background
  path is disabled by default and not deployed. Before continuing, read the
  [continuation handoff](./docs/duplicate-detection-handoff.md) for the five-day window,
  selected sample dataset, comparison deployment prerequisite, and remaining work.
- **Stack & datastore are settled:** JavaScript + JSDoc backend and frontend
  ([ADR 0004](./docs/adr/0004-javascript-with-jsdoc.md)), single-table DynamoDB
  ([ADR 0002](./docs/adr/0002-datastore-dynamodb.md)), 2-env deploy pipeline
  ([ADR 0007](./docs/adr/0007-deploy-promotion-model.md)) — dev live-proven, prod pending
  first release-deploy (issue tracker).
- **Built and live in the repo:** the perimeter-check → analyzer → guidance-workflow
  pipeline (see [docs/architecture.md](./docs/architecture.md)), error tracking
  ([ADR 0008](./docs/adr/0008-lean-client-error-capture.md); rollout completion tracked as
  an issue), and the Docker-free local harness ([ADR 0006](./docs/adr/0006-docker-free-local-dev-harness.md)).
- **Offline is partial.** A Workbox service worker precaches the built app so it opens
  offline (`offlineShell` in `frontend/vite.config.js`); it never touches API calls. Queuing
  writes lives in the app, not Workbox background sync: care work logs and perimeter checks
  each have a durable queue (`services/care-submissions.js`, `services/check-submissions.js`),
  and home shows its last saved lists while offline.
- Live transcription was dropped (2026-09-02) — keyboard dictation covers the need; see
  [ADR 0009](./docs/adr/0009-drop-transcription.md).

## Standing Project Choices

- Write application code in JavaScript (ES modules), not TypeScript. Get type safety
  without a transpile step by type-checking `.js` files with the TypeScript compiler in
  `checkJs` mode, expressing types in JSDoc. `tsc --noEmit` (run as `npm run typecheck`
  in CI) is the type gate; source runs unmodified in the browser and on Lambda. See
  [ADR 0004](./docs/adr/0004-javascript-with-jsdoc.md).
- Use native web components for UI and Web Awesome for shared UI primitives.
- Buttons are always native `<button>` + a token-built `.btn-*` class — never
  `<wa-button>`. Form controls (wa-input, wa-select, wa-textarea, wa-checkbox,
  wa-otp-input), icons, spinners, badges, callouts, and alerts stay Web Awesome.
  See [ADR 0011](./docs/adr/0011-native-buttons.md).
- All user-visible copy goes through the translation catalogs (`t("key")`; see
  [docs/localization.md](./docs/localization.md)). No English literals in templates; dates only
  through `frontend/src/i18n/dates.js` (the one place a fixed locale is allowed, for
  calendar arithmetic); tests assert via `t()` and locate by ids / data attributes.
- Use Workbox for offline capture and sync.
- Use AWS Lambda, API Gateway, SQS, Bedrock, Cognito, S3, CloudFront, WAF, and DynamoDB.
- Use a single-table DynamoDB design accessed through the AWS SDK (`@aws-sdk/lib-dynamodb`
  Document Client); schema/indexes are defined in Terraform. See
  [docs/dynamodb-data-model.md](./docs/dynamodb-data-model.md).
- Use Terraform for all infrastructure and GitHub Actions for CI/CD.

## Agent Rules

- **Never push or commit code.** The human pushes and commits code changes themselves; agents stop after code changes and say what's ready to review.
- **Review for public disclosure before handing off changes.** Do this automatically,
  without waiting for the human to ask whether changes are safe to publish:
  - Review the task's staged and unstaged changes and new files intended for inclusion.
    Account for untracked files; a tracked-file diff alone is not sufficient. State the
    scope reviewed and identify any unrelated changes that were not reviewed.
  - Check for credentials, API keys, private keys, tokens, signed URLs, connection
    strings containing secrets, and accidentally included environment or Terraform
    state files. Run the configured Gitleaks scanner when available, with redacted
    output and a scope that includes the proposed changes, not just committed history.
    If the scanner is unavailable or cannot cover that scope, disclose the limitation.
  - Review for personal or confidential information in code, docs, fixtures, logs,
    exports, screenshots, images, and other new artifacts. Distinguish intentional
    public contact information and synthetic examples from private information about
    real people; do not assume a secret scanner detects PII.
  - Remove or replace sensitive material introduced by the task with synthetic data
    or secret-store references. Do not silently edit unrelated work or add broad
    scanner allowlists to make findings pass. Report findings by file and location
    without reproducing sensitive values. Flag any exposed credential for revocation
    or rotation; deleting it from the current diff does not invalidate it.
  - Include a concise result in the handoff: scope, checks performed, findings, and
    any unreviewed artifacts or limitations. Say "no findings within the reviewed
    scope" when appropriate; do not promise that publication is risk-free. Surface
    unresolved findings before describing changes as ready to publish.

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
- Pin external GitHub Actions to full commit SHAs with release-version comments.
  CI enforces this with `node scripts/check-action-pins.mjs`; weekly Dependabot
  action updates are reviewed through `dev` before production promotion.

## Skills

Project-local skills are vendored under `.claude/skills` from:

- `Mayor-s-Office-of-Innovation/skills/dashboard-review`
- `Mayor-s-Office-of-Innovation/skills/web-dev`

Use the `web-dev` skill for frontend work. User architecture overrides the skill defaults where they differ: this project uses AWS hosting instead of GitHub Pages (the DynamoDB datastore now matches the skill default).

Use the `dashboard-review` skill only after dashboards or data visualizations exist and need source, denominator, tone, and clarity review.
