# Level 2 SDLC Checklist

Source: https://sfgov.github.io/ccsf-sdlc-requirements/

## Baseline

- [x] Git repository initialized.
- [x] Project files, documentation, infrastructure, and CI/CD live in Git.
- [x] Pre-commit configuration includes secret detection, linting hygiene, Terraform validation, and SAST-style IaC scanning.
- [ ] Contributors have run `pre-commit install`.
- [ ] Commit signing is configured for maintainers.

## Full Standard

- [x] Monorepo structure: `frontend`, `backend`, `infra`, `docs`.
- [x] Terraform-based infrastructure with environment roots and reusable modules.
- [x] GitHub Actions CI for lint, test, build, security scans, and Terraform validation.
- [x] Dependabot configured.
- [x] Code ownership control: `main` branch locked to the two admin accounts. *(CODEOWNERS removed 2026-08-18 — no GitHub teams; the branch lock is the ownership control for this 2-person repo. Re-add naming individual handles if code-owner review is ever required.)*
- [x] Required CCSF cloud tags encoded in Terraform.
- [x] Managed AWS services selected for compute, API, queueing, AI, auth, storage, CDN, WAF, and database.
- [x] Secrets storage pattern documented.
- [ ] DT Platform Engineering engagement recorded.
- [ ] GitHub branch protections enabled in repository settings.
- [ ] GitHub environments configured for protected deploys.
- [ ] Remote Terraform state bucket and DynamoDB lock table provisioned.
- [ ] Security review completed before go-live.
- [ ] Mozilla Observatory A+ verified before go-live.
- [ ] SSL Labs A+ verified before go-live.
- [ ] Core Web Vitals verified before go-live.
