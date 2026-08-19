# Plan: Deploy & CI/CD — remaining prod validation

**Status:** Nearly done. The pipeline is built and the **dev half is live-proven** (merge-to-`dev`
ran the full job green 2026-08-18: OIDC → remote-state init → Lambda bundle → `terraform apply` →
frontend sync + env-scoped invalidation → `/health` smoke). GitHub Environments + secrets, remote
Terraform state, both deploy workflows, per-env S3/CloudFront, and `main`/prod protection are all
in place. **Two things remain, both prod-side.** · **Date:** 2026-08-18 · **Owner:** team ·
[index](../README.md)

> The promotion model (2 branches / 2 envs, superseding the original 3-env/tag model) and the
> deliberate single-person-path-to-prod trade are codified in
> [ADR 0007](../adr/0007-deploy-promotion-model.md). Read that for the *why*; this doc tracks only
> what's left to do.

---

## Remaining task 1 — first prod release-deploy (release path untested)

Everything on the prod path is **built but never exercised end-to-end**: the
[`deploy-prod.yml`](../../.github/workflows/deploy-prod.yml) `release:[published]` trigger, the
`prod` Environment's `v*`-tag deployment rule, the required-reviewer approval pause, the prod
CloudFront/API-Gateway/Lambda apply, and the `/health` smoke against the prod `api_url`.

Validate by cutting the **first real release**:

1. Merge `dev`→`main` (admins-only).
2. Publish a **GitHub Release** on `main` with a semver **`vX.Y.Z`** tag (the leading `v` satisfies
   the prod Environment's `v*` deployment-tag rule).
3. Confirm the run **pauses for approval** in the `prod` Environment, then approve (either admin;
   self-review allowed per [ADR 0007](../adr/0007-deploy-promotion-model.md)).
4. Confirm the apply provisions prod, the frontend syncs to the prod bucket, **only the prod**
   distribution is invalidated, and the `/health` smoke passes.

- **Done when:** a published `v*` Release from `main` deploys prod behind the approval pause with a
  green smoke test, and the prod frontend serves from its own CloudFront distribution.

## Remaining task 2 — rollback runbook dry-run

The runbook below is the **source of record** until it's been dry-run at least once, after which it
graduates to `docs/runbooks/rollback.md`. GNP is Terraform, so rollback is
**revert-and-reapply**:

1. Confirm the affected environment + the deploy run that introduced the change.
2. **Revert the offending PR** on `dev` (or cut a rollback PR); let CI pass.
3. For **dev**, the merge auto-redeploys. For **prod**, merge the revert `dev`→`main` and **publish
   a new Release** (e.g. `v…-rollback`) to deploy through the same gated workflow.
4. Re-run the **`/health` smoke test**.
5. **State drift / partial apply:** if an apply half-failed, re-run `terraform apply` to converge;
   only touch state manually (`state rm`/import) with an owner's sign-off and never hand-edit state.
6. Record incident, root cause, follow-up issue.

Avoid out-of-band console changes except in a declared emergency with owner approval — they cause
the drift in step 5.

- **Done when:** the runbook has been dry-run at least once and moved to `docs/runbooks/rollback.md`.

---

## Acceptance criteria (what's left of the plan)

1. A published `v*` Release from `main` → prod **behind a required-reviewer approval pause** (single
   approver; self-review allowed — see [ADR 0007](../adr/0007-deploy-promotion-model.md)), with an
   env-scoped CloudFront invalidation and a passing `/health` smoke.
2. The Terraform rollback runbook has been dry-run at least once.
