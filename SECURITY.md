# Security Policy

## Reporting a Vulnerability

Do not open public issues for vulnerabilities or suspected secrets exposure.

Report security issues to `innovation@sfgov.org` and include:

- affected component or URL;
- steps to reproduce;
- impact and data exposure, if known;
- suggested remediation, if available.

## Project Classification

- SDLC tier: Level 2 deployed system.
- Default data classification: `sensitive`.
- Default asset criticality: `tier-2`.
- Regulated data is not approved until the project is reclassified as Level 3 and additional controls are enabled.

## Security Requirements

- Secrets are stored in AWS Secrets Manager or SSM Parameter Store.
- Authentication uses Cognito.
- Backend authorization is enforced in Lambda handlers and API Gateway authorizers.
- Managed Postgres, S3, and Terraform state are encrypted at rest.
- Public web traffic is served over TLS through CloudFront and protected by WAF.
- CI runs dependency, secret, SAST, and Terraform scans before deployment.
- Production deploys require protected GitHub environments.
