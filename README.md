# Good Neighbor App

Good Neighbor App is a new City and County of San Francisco Level 2 deployed system. It is scaffolded around the CCSF Software Development Lifecycle Standard v2.0 and the selected architecture:

- Frontend: web components, Web Awesome, Workbox, hosted on AWS S3/CloudFront.
- Backend: AWS Lambda behind API Gateway, async work through SQS, AI calls through Amazon Bedrock.
- Data: managed Postgres with Prisma migrations, object storage in S3.
- Auth: Amazon Cognito.
- Infrastructure: Terraform, applied only through GitHub Actions.

## Active Work

**[docs/README.md](docs/README.md) is the docs map** — every planning thread with its
ordered read path and current status. Start there to find your way around.

The **frontend migration is done** (Aug 2026): the backend moved to JavaScript + JSDoc and
the `gnp` prototype is now the `frontend/`, built and green — see
[docs/js-and-jsdoc-migration-plan.md](docs/js-and-jsdoc-migration-plan.md) (Step 1) and
[docs/gnp-frontend-migration-plan.md](docs/gnp-frontend-migration-plan.md) (Step 2). Still
in planning: the **database direction** (a possible move to DynamoDB) and the
**backend/auth/deploy** seams — tracked in the docs map above. Note two consequences of the
current MVP not yet reflected in the architecture summary above: **offline/Workbox is
deferred** (no service worker ships yet) and the **Postgres vs DynamoDB** choice is open.

## SDLC Tier

- Project tier: Level 2, deployed system.
- Default data classification: `sensitive` until a formal data inventory says otherwise.
- Default asset criticality: `tier-2`.
- Internet exposure: `public-facing` for the web frontend and public API edge.
- Regulated workload note: if the project stores or processes CJIS, HIPAA, PCI, or `protected`/`regulated` data, reclassify as Level 3 before production.

## Repository Layout

```text
backend/        Lambda handlers, Prisma client access, async workers
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

Prerequisites:

- Node.js 22 LTS or newer
- npm 10 or newer
- Terraform 1.9 or newer
- pre-commit
- AWS access only for approved operators; developers should work through Git and CI

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

### Clearing the local site binding

First run shows the site-setup ("code") screen and, once you confirm a site, writes a single
binding record to IndexedDB (database `conditions-reporter`, store `site`, key `current` — the
site name plus the setup code). To get the setup screen back, delete that one record
(surgical — leaves any saved checks intact):

- **DevTools:** Application → Storage → IndexedDB → `conditions-reporter` → `site` → right-click
  the `current` row → Delete, then reload.
- **Console:**
  ```js
  indexedDB.open('conditions-reporter').onsuccess = e =>
    e.target.result.transaction('site', 'readwrite').objectStore('site').delete('current');
  ```
  then reload.

To wipe everything (binding **and** saved checks) instead: `indexedDB.deleteDatabase('conditions-reporter')`
then reload. (The app holds an open connection, so a full delete may block until you reload or
close the tab — the surgical per-record delete above does not.)

## Deployment Model

All infrastructure changes are made in Terraform and reviewed through pull requests. GitHub Actions runs `terraform fmt`, `terraform validate`, Checkov, and a Terraform plan for pull requests. Applies are reserved for protected environments and should use GitHub OIDC, not long-lived AWS keys.

## Required Reviews Before Go-Live

- Security review recorded in `docs/security-review.md`.
- Mozilla Observatory A+ result for the public web endpoint.
- SSL Labs A+ result for the public domain.
- Core Web Vitals pass for the primary user journeys.
- Accessibility keyboard pass and WCAG 2.2 AA review.
- Terraform resources verified for required CCSF tags.
