# Good Neighbor App

Good Neighbor App is a tool for city supported organizations in charge of a building to collect and share information about the state of the area immediately outside their location. Employees will perform 3 perimeter checks per day taking photos around their building. They can also optionally collect information about the area via text or audio. These artifacts are reviewed by a separate service that uses AWS Bedrock AI tools to analyze the artifacts submitted and identify and issues the city is concerned with. The Good Neighbor App will track the issues identified and recommend ways to resolve them.

## Tech approach

There are around 400 sites that may use this application each of which may have a few separate inddividual users. The app needs to support less expensive mobile hardware like older ipads, cheap phones.

We will make tech choices that allow us the app to always:
- Load quickly and operate smoothly on all hardware in all network conditions
- Be fully accessible

All production releases should pass core web vitals and get perfect scores on automated accessibility assessments.

We will conform to San Francisco Department of Tech's system guidelines explained below and make cloud infrastructure choices that optimize for ease of maintenance and low cost.

## Technical information

Good Neighbor App is a new City and County of San Francisco Level 2 deployed system. It is scaffolded around the CCSF Software Development Lifecycle Standard v2.0 and the selected architecture:

- Frontend: web components, Web Awesome, Workbox, hosted on AWS S3/CloudFront.
- Backend: AWS Lambda behind API Gateway, async work through SQS, AI calls through Amazon Bedrock.
- Data: DynamoDB single-table store (`@aws-sdk/lib-dynamodb`), object storage in S3.
- Auth: Amazon Cognito.
- Infrastructure: Terraform, applied only through GitHub Actions.

### SDLC Tier

- Project tier: Level 2, deployed system.
- Default data classification: `sensitive` until a formal data inventory says otherwise.
- Default asset criticality: `tier-2`.
- Internet exposure: `public-facing` for the web frontend and public API edge.
- Regulated workload note: if the project stores or processes CJIS, HIPAA, PCI, or `protected`/`regulated` data, reclassify as Level 3 before production.

### Repository Layout

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

#### Local Development

All local setup and commands — prerequisites, install, checks, running the frontend, the
Docker-free backend harness, and resetting local state — live in the
**[developer command reference](docs/dev-commands.md)**. The harness design rationale is in
[ADR 0006](./docs/adr/0006-docker-free-local-dev-harness.md).

## Deployment Model

All infrastructure changes are made in Terraform and reviewed through pull requests. GitHub Actions runs `terraform fmt`, `terraform validate`, Checkov, and a Terraform plan for pull requests. Applies are reserved for protected environments and should use GitHub OIDC, not long-lived AWS keys.

### Branches

- dev

The default branch is ```dev``` all work should branch off here and open PRs to merge back to dev. Code cannot be merged to dev without PR. PRs must pass automated tests and be signed off by 1 reviewer. Code merged to dev will be deployed to the AWS dev environment immediately

- main

Only admins may update the main branch. Merge release ready code to main and tag a release with v* and a production deploy will kickoff.

## Required Reviews Before Go-Live

- Security review recorded in `docs/security-review.md`.
- Mozilla Observatory A+ result for the public web endpoint.
- SSL Labs A+ result for the public domain.
- Core Web Vitals pass for the primary user journeys.
- Accessibility keyboard pass and WCAG 2.2 AA review.
- Terraform resources verified for required CCSF tags.

