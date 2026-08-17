# Good Neighbor App

Good Neighbor App is a new City and County of San Francisco Level 2 deployed system. It is scaffolded around the CCSF Software Development Lifecycle Standard v2.0 and the selected architecture:

- Frontend: web components, Web Awesome, Workbox, hosted on AWS S3/CloudFront.
- Backend: AWS Lambda behind API Gateway, async work through SQS, AI calls through Amazon Bedrock.
- Data: DynamoDB single-table store (`@aws-sdk/lib-dynamodb`), object storage in S3.
- Auth: Amazon Cognito.
- Infrastructure: Terraform, applied only through GitHub Actions.

## Active Work

**[docs/README.md](docs/README.md) is the docs map** — every planning thread with its
ordered read path and current status. Start there to find your way around.

The **frontend migration is done** (Aug 2026): the backend moved to JavaScript + JSDoc and
the `gnp` prototype is now the `frontend/`, built and green — see
[docs/archive/js-and-jsdoc-migration-plan.md](docs/archive/js-and-jsdoc-migration-plan.md) (Step 1) and
[docs/gnp-frontend-migration-plan.md](docs/gnp-frontend-migration-plan.md) (Step 2). The
**datastore direction is decided — DynamoDB** (replacing managed Postgres/Prisma; see
[ADR 0002](docs/adr/0002-datastore-dynamodb.md)); the **backend/auth/deploy** seams are still
in planning — tracked in the docs map above. Note one consequence of the current MVP not yet
reflected in the architecture summary above: **offline/Workbox is deferred** (no service
worker ships yet).

## SDLC Tier

- Project tier: Level 2, deployed system.
- Default data classification: `sensitive` until a formal data inventory says otherwise.
- Default asset criticality: `tier-2`.
- Internet exposure: `public-facing` for the web frontend and public API edge.
- Regulated workload note: if the project stores or processes CJIS, HIPAA, PCI, or `protected`/`regulated` data, reclassify as Level 3 before production.

## Repository Layout

```text
backend/        Lambda handlers, DynamoDB access (@aws-sdk/lib-dynamodb), async workers
frontend/       Web components frontend — see frontend/README.md
infra/          Terraform modules and environment roots
docs/           SDLC, architecture, runbooks, ADRs, security evidence
.claude/skills/ Project-local Mayor's Office of Innovation skills
.github/        CI/CD, Dependabot, CODEOWNERS
```

The **[frontend/README.md](frontend/README.md)** is the frontend entry point — how to run it,
its layout, and the **[design system guide](docs/frontend-design-system.md)** for building new
screens to spec.

## Local Development

> **Quick command reference:** [docs/dev-commands.md](docs/dev-commands.md) — a concise
> cheat-sheet of what to run to do what (setup, checks, frontend, and the backend harness).

Prerequisites:

- Node.js 22 LTS or newer
- npm 10 or newer
- Terraform 1.9 or newer
- pre-commit
- AWS access only for approved operators; developers should work through Git and CI
- **JRE 17+ — only for the backend local harness** (below). DynamoDB Local and ElasticMQ ship
  as Java jars; DynamoDB Local 2.x needs Java 17 or newer. Note: `java.com`'s manual download
  is Java **8** and will not work. Install a current LTS build:
  - macOS: `brew install --cask temurin` (Eclipse Temurin), then confirm `java -version`
    reports 17+ (not `1.8.x`).
  - Or the Adoptium `.pkg` for your arch: <https://adoptium.net/temurin/releases/> — Apple
    Silicon = `aarch64`, Intel = `x64`.
  The frontend, tests, lint, and typecheck do **not** need Java.

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run format:check
npm run lint
npm test
npm run build
```

Run the frontend locally:

```bash
npm run dev -w frontend
```

### Run the backend locally (Docker-free harness)

Runs the exact Lambda handler + worker code against Docker-free emulators (DynamoDB Local +
ElasticMQ). Needs **JRE 17+** (see Prerequisites).

```bash
cp .env.example .env.local     # one-time (git-ignored; dummy local values)
npm run dev -w backend         # starts DynamoDB Local, ElasticMQ, the API router, and the worker
```

Commands, ports, the curl loop, and the GUI are in the
**[developer command reference](docs/dev-commands.md)**; the design rationale is in
[docs/archive/local-dev-environment-plan.md](docs/archive/local-dev-environment-plan.md).

## Deployment Model

All infrastructure changes are made in Terraform and reviewed through pull requests. GitHub Actions runs `terraform fmt`, `terraform validate`, Checkov, and a Terraform plan for pull requests. Applies are reserved for protected environments and should use GitHub OIDC, not long-lived AWS keys.

## Required Reviews Before Go-Live

- Security review recorded in `docs/security-review.md`.
- Mozilla Observatory A+ result for the public web endpoint.
- SSL Labs A+ result for the public domain.
- Core Web Vitals pass for the primary user journeys.
- Accessibility keyboard pass and WCAG 2.2 AA review.
- Terraform resources verified for required CCSF tags.
