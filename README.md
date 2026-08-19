# Good Neighbor App

Good Neighbor App is a new City and County of San Francisco Level 2 deployed system. It is scaffolded around the CCSF Software Development Lifecycle Standard v2.0 and the selected architecture:

- Frontend: web components, Web Awesome, Workbox, hosted on AWS S3/CloudFront.
- Backend: AWS Lambda behind API Gateway, async work through SQS, AI calls through Amazon Bedrock.
- Data: DynamoDB single-table store (`@aws-sdk/lib-dynamodb`), object storage in S3.
- Auth: Amazon Cognito.
- Infrastructure: Terraform, applied only through GitHub Actions.

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
.github/        CI/CD, Dependabot
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

The first screen asks for a provider-site code. With the local backend running,
`123-456` is seeded as an active code and `000-000` is seeded as inactive.

### Run the backend locally (Docker-free harness)

Runs the exact Lambda handler + worker code against Docker-free emulators (DynamoDB Local +
ElasticMQ). Needs **JRE 17+** (see Prerequisites).

```bash
cp .env.example .env.local     # one-time (git-ignored; dummy local values)
npm run dev -w backend         # starts DynamoDB Local, ElasticMQ, the API router, and the worker
```

Commands, ports, the curl loop, and the GUI are in the
**[developer command reference](docs/dev-commands.md)**; the design rationale is in
[ADR 0006](./docs/adr/0006-docker-free-local-dev-harness.md).

The local API router listens on `LOCAL_API_PORT` from `.env.local` (`3001` by default).

### Clearing the local site binding

First run shows the site-setup ("code") screen and, once you confirm a site, writes a single
binding record to IndexedDB (database `conditions-reporter`, store `site`, key `current`).
To get the setup screen back, delete that one record (surgical — leaves any saved checks
intact):

- **DevTools:** Application → Storage → IndexedDB → `conditions-reporter` → `site` →
  right-click the `current` row → Delete, then reload.
- **Console:**
  ```js
  indexedDB.open('conditions-reporter').onsuccess = e =>
    e.target.result.transaction('site', 'readwrite').objectStore('site').delete('current');
  ```
  then reload.

To wipe everything (binding **and** saved checks) instead:
`indexedDB.deleteDatabase('conditions-reporter')` then reload. (The app holds an open
connection, so a full delete may block until you reload or close the tab — the surgical
per-record delete above does not.)

## Deployment Model

All infrastructure changes are made in Terraform and reviewed through pull requests. GitHub Actions runs `terraform fmt`, `terraform validate`, Checkov, and a Terraform plan for pull requests. Applies are reserved for protected environments and should use GitHub OIDC, not long-lived AWS keys.

### Branches

- dev

The default branch is ```dev``` all work should branch off here and open PRs to merge back to dev. Code merged to dev will be deployed to the AWS dev environment immediately

- main

Only admins may update the main branch. Merge release ready code to main and tag a release with v* and a production deploy will kickoff.

## Required Reviews Before Go-Live

- Security review recorded in `docs/security-review.md`.
- Mozilla Observatory A+ result for the public web endpoint.
- SSL Labs A+ result for the public domain.
- Core Web Vitals pass for the primary user journeys.
- Accessibility keyboard pass and WCAG 2.2 AA review.
- Terraform resources verified for required CCSF tags.

