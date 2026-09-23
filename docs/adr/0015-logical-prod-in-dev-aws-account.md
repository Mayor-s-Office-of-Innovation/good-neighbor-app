# ADR 0015: Logical production deployment in the existing DEV AWS account

## Status

Accepted (2026-09-23). Amends the account-topology assumption in
[ADR 0007](0007-deploy-promotion-model.md); its branch, release, and reviewer
promotion model remains in force.

## Context

The public `goodneighbor.sf.gov` delegation already points to the four name
servers of Route 53 hosted zone `Z013233314Z835D93KVOT` in AWS account
`518892333858` (the existing DEV account). That account's versioned, locked
Terraform backend already contains a separate `prod/terraform.tfstate` owning
the zone, DNSSEC keys/signing, and query logging. Moving the canonical domain
to a newly created zone in another account would require a new parent
delegation and a coordinated DNSSEC transition, neither of which is needed to
deploy the application.

The dev root already owns a verified `goodneighborsf.org` SES identity in this
account. The production app can consume its ARN without importing a duplicate
SES identity or taking ownership of the external parent DNS zone.

## Decision

- Keep `dev` and `prod` as separate Terraform roots and state keys in account
  `518892333858`. Preserve the existing production hosted zone and nameservers.
- Keep `dev` branch auto-deployment to `dev.goodneighborsf.org`. A `v*` GitHub
  Release tag on a `main` commit, plus the `prod` Environment reviewer approval,
  deploys the production app to `goodneighbor.sf.gov`.
- Use separate GitHub Environment secrets and OIDC roles. The production role is
  `arn:aws:iam::518892333858:role/good-neighbor-app-deploy-prod`. CI asserts
  the expected account and existing zone and rejects changes to protected DNS
  resources in an application deployment plan.
- A manual production run from a `v*` tag is plan-only, so the first full
  application plan can be reviewed before a Release is published. The Release
  run is the only production apply path.
- The production app claims only `goodneighbor.sf.gov` as a CloudFront alias.
  The external `goodneighborsf.org` parent zone and the
  `dev.goodneighborsf.org` delegation remain untouched.
- The dev Terraform root remains the sole owner of the shared SES domain
  identity; production reads its ARN from dev remote state.

## Consequences

Logical separation is not AWS-account isolation: account-level limits,
administration, and a compromised account can affect both environments. Separate
IAM roles, state keys, resource names, GitHub Environment controls, and plan
guards reduce accidental cross-environment changes, but do not erase that
shared-account risk. Revisit a dedicated production account only as a planned
migration with DNS delegation, DNSSEC, SES, and state-transfer runbooks.
