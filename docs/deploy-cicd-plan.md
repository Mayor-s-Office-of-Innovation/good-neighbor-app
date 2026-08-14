# Plan: Deploy & CI/CD — environments, promotion, protection

**Status:** Plan (not yet executed) · **Date:** 2026-08-14 · **Owner:** team ·
[index](./README.md)

The plan to take GNP from *manual, single-role, dev/prod-only* deploys to a **3-environment,
gated, auto-promoting** pipeline. It fills the deploy gaps tracked in
[MVP-TODO → deploy & harden](./MVP-TODO.md#mvp-critical-path--deploy--harden) and closes the
open items in the [SDLC Level 2 checklist](./sdlc-level-2-checklist.md) (branch protection,
GitHub environments, remote state). The reference model is the sibling analyzer service
(`../street-conditions-analysis`, `docs/deployment.md` + `docs/branch-protection.md`), adapted
from **CDK → Terraform** and from a 2-tier to a **2-branch-plus-gates** promotion flow.

> **What this is not.** This is a *deploy mechanics* plan. It does not decide app features,
> data model, or the auth posture (those live in their own docs). It assumes the
> [DynamoDB table](./dynamodb-buildout-plan.md) and [analysis Lambdas](./analysis-backend-lambdas-plan.md)
> land through the pipeline this plan builds.

---

## Decisions locked (2026-08-14)

| # | Decision | Choice |
|---|---|---|
| **P1** | Promotion model | **2 long-lived branches + gates.** `main` is trunk. No `dev`/`stage` integration branches. |
| **P2** | Environments | **`dev`, `staging`, `prod`** — three Terraform env roots, three GitHub Environments. |
| **P3** | dev deploy trigger | **Auto** on push/merge to `main`. |
| **P4** | staging / prod triggers | **Promote by git tag** (`staging-*` → staging, `v*` → prod), plus `workflow_dispatch` reruns. No third branch to keep in sync. |
| **P5** | prod gate | **GitHub Environment required reviewers = @you + @beaudry**, with **"prevent self-review" ON** (release pusher can't approve their own deploy). |
| **P6** | Frontend | **Per-env S3 bucket + CloudFront distribution + domain.** Each deploy syncs that env's bucket and **invalidates only that env's distribution.** |
| **P7** | Credentials | **AWS OIDC only** (no long-lived keys, no laptop deploys). Per-env deploy role + a read-only plan role for PR diffs. |

Why not 3 branches (`dev → stage → main`): three long-lived branches buy promotion overhead,
drift, and back-merge pain. Environments are cheap; long-lived branches are not. Tag-based
promotion gives the same "explicit gate before staging/prod" without a third branch to
reconcile. A `stage` branch can be added later if a real pre-prod integration need appears.

---

## ⛔ The one blocking dependency: the admin bootstrap contract

GNP's org uses an **admin/landing-zone account that runs a one-time scaffolding step per new
deploy target**; after that, all environments are deployable from CI. Nothing in this repo
documents that step's **interface**, and the pipeline can't assume real AWS credentials until
we have it. **These five facts must be confirmed with whoever owns the admin account** before
the deploy workflows can be filled in (everything else in this plan can be built without them):

1. **Scope of the bootstrap** — does the admin step create the **GitHub OIDC identity
   provider**, the **deploy role(s)**, *and* the **Terraform state bucket + DynamoDB lock
   table**? Or only some (and we create the rest per-env)?
2. **One role or per-env roles** — does it hand back a **single assumable role reaching all
   envs**, or **one deploy role per env** (`dev`/`staging`/`prod`)? This decides how many
   GitHub Environment secrets we set and whether separation is at the role or the environment.
3. **Read-only plan role** — is there (or can there be) a **least-privilege role for PR
   `terraform plan`**, separate from the deploy role?
4. **State layout** — one state bucket with per-env keys (`dev/`, `staging/`, `prod/`
   — matching the commented `backend "s3"` blocks already in
   [infra/environments/*/main.tf](../infra/environments/dev/main.tf)) or per-env buckets?
   Confirm **bucket name, region, lock table name**.
5. **Trust-policy scope** — is the OIDC role's trust condition scoped to this repo **and which
   refs** (branches / tags / environments)? Tag-based promotion (P4) only works if the trust
   policy permits assuming the role from **tag pushes and the `staging`/`prod` environments**.

**Interim posture until confirmed:** keep deploys on the existing manual
[`workflow_dispatch`](../.github/workflows/deploy.yml) path; build and merge everything in
Phases 1–3 below (staging env root, plan-on-PR job, protection rules, frontend publish, smoke
tests) with role ARNs / backend values left as documented placeholders.

---

## Target-state model

```
 PR  ──▶ CI (lint/type/test/build + tf fmt/validate/checkov)   ← required to merge
     └─▶ terraform plan (read-only role, infra/** paths)        ← preview, non-blocking

 merge to main ──▶ deploy DEV        (auto, environment: dev)     + /health smoke
 tag staging-*  ──▶ deploy STAGING   (environment: staging)       + /health smoke
 tag v*         ──▶ deploy PROD       (environment: prod, APPROVAL) + /health smoke
```

**Environments** (Terraform env roots + GitHub Environments, one-to-one):

| Env | Trigger | GH Environment protection | Data classification | Hostname |
|---|---|---|---|---|
| `dev` | push to `main` | none (fast inner loop) | low / disposable test data | execute-api URL + dev frontend domain |
| `staging` | tag `staging-*` | branch/tag restriction to release tags | mirrors prod | staging frontend domain |
| `prod` | tag `v*` | **required reviewers (you + beaudry), no self-review**; tag restriction | prod | prod frontend domain |

**Promotion is a tag, not a merge.** `main` is always the source; a release is cutting a tag
off a `main` commit. `staging-2026.08.14` deploys staging; after validation, `v2026.08.14`
(the same commit) deploys prod behind approval. This keeps one lineage and makes "what's in
prod" a `git describe` away.

---

## Phase 1 — Terraform: add the `staging` env root + remote state

- Add **`infra/environments/staging/`** as a peer of `dev`/`prod` (copy `dev`, set
  `environment = "staging"`, backend key `staging/terraform.tfstate`, and prod-like
  `data_classification` / `internet_exposure` / `asset_criticality`). Today `dev` and `prod`
  are byte-identical bar a comment; `staging` follows the same shape.
- **Uncomment and fill the `backend "s3"` blocks** in all three env roots with the bucket /
  region / lock-table values from **bootstrap fact #4**. This is the SDLC-checklist "remote
  Terraform state" item.
- Extend [`infra/modules/app`](../infra/modules/app/main.tf) as needed so the module is
  env-parameterized (it already keys resource names off `${application}-${environment}`).
- **Done when:** `terraform init` + `validate` pass in all three roots and `terraform plan`
  (once the plan role exists) is clean per env.

## Phase 2 — CI: add `terraform plan` preview on PRs

- Add a **`terraform-plan`** job to [`ci.yml`](../.github/workflows/ci.yml), path-filtered to
  `infra/**`, that assumes the **read-only plan role** (bootstrap fact #3) via OIDC and runs
  `terraform plan` against the `dev` state, posting/printing the diff. This is the Terraform
  analog of the sibling repo's `cdk-diff.yml`.
- Guard it like the sibling does: **skip cleanly when the plan-role ARN is unset** (so PRs
  from forks / pre-bootstrap don't fail) — print "set `AWS_DEV_PLAN_ROLE_ARN` to enable
  authenticated plans."
- Keep the existing unauthenticated `terraform fmt/validate/checkov` job as-is (it already
  runs and needs no credentials).
- **Done when:** a PR touching `infra/**` shows a real plan diff (post-bootstrap) or the
  skip message (pre-bootstrap), and CI stays green either way.

## Phase 3 — Deploy workflows: auto-dev + tag-promoted staging/prod

Replace the single manual [`deploy.yml`](../.github/workflows/deploy.yml) with a
**parameterized deploy** driven by triggers (a reusable workflow called by three thin trigger
workflows, or one workflow with trigger-derived `environment`). Each deploy job:

1. runs the full check suite (lint/type/test/build) — belt-and-suspenders with CI,
2. assumes the **env's deploy role** via OIDC (`environment:` set so GH protection applies),
3. `terraform init/plan/apply` in that env root,
4. **frontend publish** (Phase 4),
5. **`/health` smoke test** against the deployed API (GNP already has a `/health` handler),
6. uses a per-env `concurrency` group so overlapping deploys queue rather than race.

Trigger map (illustrative — final YAML written against confirmed roles):

```yaml
# dev: on push to main
on: { push: { branches: [main] } }         # environment: dev

# staging: on staging-* tags
on: { push: { tags: ['staging-*'] } }        # environment: staging

# prod: on v* tags  (GH Environment requires reviewer approval before creds are issued)
on: { push: { tags: ['v*'] } }               # environment: prod
```

- **Done when:** merging to `main` auto-deploys dev with a passing smoke test; a `staging-*`
  tag deploys staging; a `v*` tag **pauses for approval** then deploys prod.

## Phase 4 — Frontend build + publish (per-env, env-scoped invalidation)

Folds in the existing **I1** item ([MVP-TODO](./MVP-TODO.md), "frontend build + publish").

- Provision, per env, an **S3 bucket + CloudFront distribution + domain** in Terraform (TLS,
  HSTS/CSP security headers, WAF managed rules, CCSF tags), with **block-public-access** and
  CloudFront **origin access** only.
- The deploy job builds the frontend, **`aws s3 sync`s to that env's bucket**, then creates a
  **CloudFront invalidation scoped to that env's distribution ID only** (P6) — never a
  cross-env invalidation.
- Per-env frontend config (API base URL etc.) is injected at build time from the env's GitHub
  Environment vars, so `dev`/`staging`/`prod` builds point at their own API.
- **Done when:** each env serves its own frontend on its own domain and a deploy invalidates
  exactly that env's cache.

## Phase 5 — GitHub protection rules (repo settings, not code)

These are configured in **repo settings**; this section is the source of record until they're
enabled, then graduates to a standalone `docs/branch-protection.md`.

**Branch protection — `main`:**
- Require a pull request before merging; **require ≥1 approving review**; **require review
  from CODEOWNERS**.
- Require the **`CI` workflow** to pass; require branches up to date when practical.
- Restrict / disable direct pushes; no bypass for infra-sensitive changes without a recorded
  reason.

**Environment protection:**
- **`prod`** — required reviewers **@you + @beaudry**, **"prevent self-review" ON** (P5);
  restrict deployments to `v*` tags.
- **`staging`** — restrict deployments to `staging-*` tags; approval optional.
- **`dev`** — no gate (fast loop).

**CODEOWNERS caveat:** [.github/CODEOWNERS](../.github/CODEOWNERS) currently points at four
teams (`maintainers`/`platform`/`backend`/`frontend`/`security`). CODEOWNERS review
enforcement **only works if those GitHub teams exist and hold repo access**. Confirm they
exist, or consolidate to a single team (the sibling repo uses one `moi-admins` team). With
just two committers, a single owning team is the simpler choice.

- **Done when:** `main` can't be pushed to directly, a prod tag pauses for the *other* admin's
  approval, and the SDLC-checklist "branch protections" + "GitHub environments" items flip to
  done.

## Phase 6 — Rollback runbook (Terraform)

Source of record until enabled, then graduates to `docs/runbooks/rollback.md`. GNP is
Terraform, so rollback is **revert-and-reapply**, not CloudFormation stack rollback:

1. Confirm the affected environment + the deploy run that introduced the change.
2. **Revert the offending PR** (or cut a rollback PR) on `main`; let CI pass.
3. For **dev**, the merge auto-redeploys. For **staging/prod**, cut a new tag off the reverted
   commit (`v…-rollback`) and deploy through the same gated workflow.
4. Re-run the **`/health` smoke test**.
5. **State drift / partial apply:** if an apply half-failed, re-run `terraform apply` to
   converge; only touch state manually (`state rm`/import) with an owner's sign-off and never
   hand-edit the state file.
6. Record incident, root cause, follow-up issue.

Avoid out-of-band console changes except in a declared emergency with owner approval — they
cause the drift in step 5.

---

## What blocks on what

```
bootstrap contract (external)
        │  (role ARNs, state bucket, trust scope)
        ▼
Phase 1 staging root ──▶ Phase 2 plan-on-PR ──▶ Phase 3 deploy workflows ──▶ Phase 4 frontend
        │                                                │
        └───────────────── Phase 5 protection rules ─────┴──▶ Phase 6 rollback runbook
```

Phases 1, 5, and 6 can be **drafted/merged now** (staging root with placeholder backend, the
protection rules, the runbook). Phases 2–4 can be **written now** but only go live once the
bootstrap facts fill in the role ARNs and state values.

## Acceptance criteria (whole plan)

1. Three Terraform env roots (`dev`/`staging`/`prod`) with remote S3 state + locking.
2. PRs show an authenticated `terraform plan` preview; `main` merges auto-deploy dev.
3. `staging-*` tag → staging; `v*` tag → prod **behind two-admin approval with no self-review**.
4. Every deploy runs a `/health` smoke test and (frontend) an **env-scoped** CloudFront
   invalidation.
5. `main` is branch-protected (PR + CI + CODEOWNERS); prod/staging environments are
   tag-restricted; no long-lived AWS keys anywhere.
6. A Terraform rollback runbook exists and has been dry-run at least once.

## Open questions (beyond the bootstrap contract)

- **Pre-prod hostnames** — dev/staging on execute-api URLs + a dev/staging frontend domain, or
  real subdomains? (Reserve the production hostname for prod only.)
- **Do the CODEOWNERS teams exist**, or consolidate to one owning team (Phase 5)?
- **Tag scheme** — `vYYYY.MM.DD` calendar tags vs semver `vX.Y.Z`? (Either works; pick one for
  `git describe` legibility.)
