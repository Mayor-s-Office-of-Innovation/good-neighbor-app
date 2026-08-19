# ADR 0007: Deploy Promotion Model & Prod Gate

## Status

Accepted (2026-08-18). Supersedes the original (2026-08-14) three-environment,
tag-promotion deploy model, which was never built. Builds on the architecture in
[ADR 0001](0001-architecture-stack.md).

## Context

GNP is moving from manual, single-role deploys to an automated pipeline. The original plan
proposed **three** environments (`dev`/`staging`/`prod`) promoted by **git tags** off a single
`main` trunk. Two facts pushed against it: the admin bootstrap provisioned only `dev` + `prod`
deploy roles, and the team already runs a familiar branch-per-environment flow. There was no
real pre-prod need for a `staging` tier.

The team is **two people**. A prod gate that requires a *second distinct* human to approve every
release fails closed whenever only one admin is available — an unacceptable availability cost for
a team this size.

## Decision

**Two long-lived branches, two environments, one-to-one:**

- `dev` is the integration branch (all feature PRs target it); merging to `dev` **auto-deploys**
  the dev environment.
- `main` is the release branch, **admins-only**; a **GitHub Release published** from `main`
  deploys prod. A Release points at a tag, so prod lineage stays a `git describe` away. By
  convention releases are cut from `main`, so prod ships a reviewed `main` commit rather than
  `dev`'s tip — but this rests on admin discipline, **not** on pipeline enforcement (see
  Consequences).
- Credentials are **AWS OIDC only** — a per-env deploy role whose trust is scoped to the GitHub
  Environment (`environment: dev` / `prod`), not to the trigger. So the branch-vs-tag trigger is a
  repo-side choice needing zero AWS changes.
- The `prod` GitHub Environment restricts deployments to **`v*` tags only**, so prod is reachable
  *only* via a semver release tag (a `release:[published]` run's ref is the tag, not `main`).

**Prod gate — deliberate single-person path (revisit past two people):** the `prod` Environment
requires a reviewer (either admin), but **"prevent self-review" is OFF**, so a lone admin can cut
a `v*` release and approve + deploy it unilaterally. This is a conscious 2-person-team
availability trade, not an oversight. What still stands: `main` is admins-only, prod is
`v*`-tag-only, and every deploy records a **named approver + timestamp** in the environment
history. **Re-enable prevent-self-review (and consider required review on `main`) when the team
grows past two.**

`staging` can be added later as a peer environment if a real pre-prod need appears.

## Consequences

- Matches the team's familiar branch-per-environment workflow and the roles actually bootstrapped.
- The one cost is a second long-lived branch: an urgent prod fix still travels PR → `dev` →
  `dev`→`main` → Release. A declared-emergency fast-track onto `main` must be followed by an
  immediate `main`→`dev` merge or the branches drift.
- Release tags **must** match `v*`, and a manual prod re-run must replay the tag-triggered run
  (re-run jobs) — a branch-ref `workflow_dispatch` is refused by the tag rule.
- The prod gate does not enforce two-person control until the team grows; the audit record
  (named approver + timestamp) is the compensating control until then.
- **The tag→`main` link is convention, not enforcement.** The `prod` Environment's `v*` rule
  matches the tag *name* only; nothing verifies the tagged commit is an ancestor of `main`, and
  `deploy-prod.yml` → `deploy.yml` check out the tag's commit with no ancestry check. A `v*` tag
  placed on an arbitrary commit would pass both the tag rule and the approval gate and deploy that
  commit. Only the two admins can publish releases, so this currently rests on their discipline. To
  make the guarantee real, add a deploy step that fails unless
  `git merge-base --is-ancestor <tag> origin/main`.
