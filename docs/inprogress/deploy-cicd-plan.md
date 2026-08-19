# Plan: Deploy & CI/CD — environments, promotion, protection

**Status:** In progress — bootstrap done, backend enabled, deploy workflows built (Phase 3),
**frontend publish + API/Lambdas in Terraform built (Phase 4)** — CloudFront + API Gateway v2 +
Lambdas provisioned, deploy job builds/syncs/invalidates and runs the now-wired `/health` smoke
test; `main` Phase 5 protection done (`main` admins-only, prod tags-`v*` + required reviewers with
self-review allowed per P5); **first live DEV apply GREEN 2026-08-18** — merge-to-`dev` ran the full
job end to end (OIDC role assumed → remote-state init → Lambda bundle → `terraform apply` →
frontend sync + env-scoped invalidation → `/health` smoke), so OIDC smoke + the dev inner loop are
proven; remaining: first **prod** release-deploy (release-tag path still untested) + rollback
dry-run · **Date:** 2026-08-18 · **Owner:** team · [index](../README.md)

The plan to take GNP from *manual, single-role* deploys to a **2-environment, branch-and-release
promoted** pipeline. It fills the deploy gaps tracked in
[MVP-TODO → deploy & harden](./MVP-TODO.md#mvp-critical-path--deploy--harden) and closes the open
items in the [SDLC Level 2 checklist](../sdlc-level-2-checklist.md) (branch protection, GitHub
environments, remote state). The AWS side is already scaffolded — see
deploy-admin-bootstrap.md.

> **Supersedes the 2026-08-14 model.** The original plan proposed **three** environments
> (`dev`/`staging`/`prod`) promoted by **git tags** off a single `main` trunk. We've simplified to
> **two long-lived branches + two environments**: a `dev` integration branch that auto-deploys the
> dev environment, and `main` (admins-only) whose **GitHub Releases** deploy prod. This matches
> what the admin actually bootstrapped (only `dev` + `prod` roles) and the team's familiar
> branch-per-environment workflow. Tag-based promotion and the `staging` tier are dropped; a
> `staging` env can be added later as a peer if a real pre-prod need appears.

---

## Decisions locked (2026-08-18)

| # | Decision | Choice |
|---|---|---|
| **P1** | Promotion model | **2 long-lived branches.** `dev` is the integration branch (all feature PRs target it); `main` is the release branch, admins-only. |
| **P2** | Environments | **`dev`, `prod`** — two Terraform env roots, two GitHub Environments, one-to-one. |
| **P3** | dev deploy trigger | **Auto** on merge to `dev`. |
| **P4** | prod deploy trigger | **GitHub Release published** from `main` (`on: release: [published]`). Release is cut after `dev`→`main` merge. |
| **P5** | prod gate | **GitHub Environment required reviewers = @you + @beaudry** (only one need approve). **"Prevent self-review" OFF** (revised 2026-08-18) so a single admin can approve + deploy when the other is unavailable — a deliberate 2-person-team availability trade; the approval *pause* + named-approver audit record stay. **Re-enable prevent-self-review when the team grows past two.** |
| **P6** | Frontend | **Per-env S3 bucket + CloudFront distribution + domain.** Each deploy syncs that env's bucket and **invalidates only that env's distribution.** |
| **P7** | Credentials | **AWS OIDC only** (no long-lived keys). Per-env deploy role, trust **scoped to the GitHub Environment** — so the trigger mechanism is a repo-side choice needing no AWS changes. |

Why two branches (not tag-promotion off one trunk): the team already runs a branch-per-environment
flow and finds it familiar; `dev` is already PR- and CI-protected. A release off `main` still
creates a tag, so "what's in prod" stays a `git describe` away without the overhead of a hand-cut
promotion tag. The one cost — a second long-lived branch — is accepted (see *Hotfixes* below).

---

## Prerequisites — admin bootstrap (DONE)

The one-time AWS scaffolding in deploy-admin-bootstrap.md is
**complete**. We have: the GitHub OIDC provider ARN, the Terraform state bucket
(`good-neighbor-app-terraform-state`) + lock table (`good-neighbor-app-terraform-locks`) in
`us-west-2`, and **per-env deploy roles** (`good-neighbor-app-deploy-dev` / `-prod`) whose trust
policy `sub` is scoped to `repo:…good-neighbor-app:environment:dev` / `:environment:prod`.

**That environment-scoped trust is the load-bearing fact for this plan:** a deploy job can assume
its role *only* when it declares `environment: dev` (or `prod`). The trust policy doesn't care what
*triggered* the job (branch push, release, dispatch) — only that the job runs in the named GitHub
Environment. So switching from the old tag model to this branch+release model needs **zero
AWS-side changes**.

---

## Target-state model

```
 PR to dev ──▶ CI (lint/type/test/build + tf fmt/validate/checkov)   ← required to merge (in place)

 merge to dev ─────────▶ deploy DEV   (auto, environment: dev)              + /health smoke
 dev ──▶ main (admins) ─▶ [main = release source]
 Release published ────▶ deploy PROD  (environment: prod, APPROVAL gate)    + /health smoke
```

**Environments** (Terraform env roots + GitHub Environments, one-to-one):

| Env | Trigger | GH Environment protection | Data classification | Hostname |
|---|---|---|---|---|
| `dev` | merge to `dev` | none (fast inner loop) | low / disposable test data | execute-api URL + dev frontend domain |
| `prod` | Release published (from `main`) | **required reviewers (you + beaudry); self-review allowed** (single approver, per P5); deployment **tag** rule restricts to `v*` | prod | prod frontend domain |

**A release is a tag.** A GitHub Release points at a tag on a `main` commit, so prod lineage is a
`git describe` away and prod always ships a reviewed `main` commit — never `dev`'s tip.

---

## ⚠️ The one deployment-protection gotcha — RESOLVED 2026-08-18

For a `release: [published]` trigger, `github.ref` is the **tag ref** (`refs/tags/<tag>`), *not*
`refs/heads/main`. So restricting the `prod` Environment's deployments to the **`main` branch** would
**block** release-triggered runs. **Resolved:** the `prod` Environment's "deployment branches and
tags" is set to **tags only, pattern `v*`** — release deploys pass; a branch ref (incl. manual
`workflow_dispatch` from `main`) is refused, so prod is reachable **only** via a `v*` tag. Two
consequences: release tags **must** match `v*`, and manual prod reruns must replay the tag-triggered
run (re-run jobs), not dispatch from a branch.

---

## Phase 1 — GitHub Environments + secrets (repo settings)

- **Create Environments** `dev` and `prod` (repo → Settings → Environments).
  - `prod`: **required reviewers** = the two admins (only one need approve); **"prevent self-review"
    OFF** (P5 — a single admin can approve when the other is out); **deployment tag rule** = tags
    `v*` (✅ set) — see the gotcha above.
  - `dev`: no gate.
- **Per-env secret + variable** in each (matches [deploy.yml](../../.github/workflows/deploy.yml), which
  reads `secrets.AWS_DEPLOY_ROLE_ARN` and `vars.AWS_REGION`):
  - Secret `AWS_DEPLOY_ROLE_ARN` → that env's deploy role ARN.
  - Variable `AWS_REGION` → `us-west-2`.
- **Verify OIDC** with the throwaway `sts get-caller-identity` job from
  deploy-admin-bootstrap.md
  before a real apply.
- **Done when:** an `environment: dev` job assumes the dev role and prints an `AROA…` identity.

## Phase 2 — Enable remote Terraform state

- **Uncomment the `backend "s3"` blocks** in [infra/environments/dev/main.tf](../../infra/environments/dev/main.tf)
  and [infra/environments/prod/main.tf](../../infra/environments/prod/main.tf) (values already match the
  bootstrapped bucket / region / lock table). First `terraform init -migrate-state` moves local state
  to S3. This is the SDLC-checklist "remote Terraform state" item.
- **Done when:** `terraform init` + `validate` pass in both roots against S3 state with locking.

## Phase 3 — Deploy workflows: auto-dev + release-triggered prod

**Built 2026-08-18.** The single manual `deploy.yml` is now a **reusable core** (`workflow_call` +
`workflow_dispatch`) called by two thin trigger workflows:

- [`deploy-dev.yml`](../../.github/workflows/deploy-dev.yml) — `push` to `dev` → core with `environment: dev`.
- [`deploy-prod.yml`](../../.github/workflows/deploy-prod.yml) — `release: [published]` → core with `environment: prod`.
- [`deploy.yml`](../../.github/workflows/deploy.yml) — the reusable core; also runnable manually for reruns.

The deploy job:

1. ~~runs the full check suite (lint/type/test/build) — belt-and-suspenders with CI~~ **deferred** —
   [`ci.yml`](../../.github/workflows/ci.yml) now runs the full suite on every push to `dev` and `main`,
   and branch protection gates merges, so the deploy doesn't re-run it. Add a `needs: checks` gate
   later if the deploy should hard-gate on its own checks.
2. ✅ assumes the **env's deploy role** via OIDC (`environment:` set so GH protection applies),
3. ✅ bundles the api + worker Lambdas (`npm run build:lambdas`) **before** `terraform plan` so
   `data.archive_file` can zip `backend/dist/{api,worker}`,
4. ✅ `terraform init/plan/apply` in that env root (now also provisions CloudFront + API Gateway +
   Lambdas),
5. ✅ **frontend publish** (Phase 4) — builds with the per-env `api_url` baked in
   (`VITE_API_BASE`), `aws s3 sync`s to that env's bucket, then invalidates **only that env's**
   CloudFront distribution,
6. ✅ **`/health` smoke test** — now wired: the env root exposes an `api_url` output, so the job
   `curl -fsS "$api_url/health"` and fails the deploy on non-200,
7. ✅ uses a per-env `concurrency` group so overlapping deploys queue rather than race.

Trigger map (as built):

```yaml
# dev: on merge to dev
on: { push: { branches: [dev] } }          # environment: dev

# prod: on GitHub Release published (from main)
on: { release: { types: [published] } }    # environment: prod  (checks out the release tag)
```

- The prod job checks out the **release's tag** (its default ref), so prod builds the reviewed
  `main` commit, not `dev`.
- **Done when:** merging to `dev` auto-deploys dev **with a passing smoke test**; publishing a Release
  **pauses for the other admin's approval** then deploys prod. *(Smoke test wired with Phase 4 — the
  `api_url` output now exists; see step 6.)* ✅ **dev half proven 2026-08-18** — a merge to `dev` ran
  the full job green (apply + smoke). The prod release-trigger + approval pause is still **untested**.

## Phase 4 — Frontend build + publish + API/Lambdas in Terraform — BUILT 2026-08-18

Folds in the existing **I1** item ([MVP-TODO](./MVP-TODO.md), "frontend build + publish") **and** the
analysis-backend "Step E — API in Terraform" work (the two are interdependent: the frontend build
needs the API's invoke URL, and the smoke test needs it too).

**Frontend serving (built):**
- ✅ Per env, an **S3 bucket + CloudFront distribution** in Terraform ([cloudfront.tf](../../infra/modules/app/cloudfront.tf)):
  OAC-only origin access (bucket stays fully private + block-public-access), redirect-to-https,
  the existing security **response-headers policy** + **CLOUDFRONT-scoped WAF** (now wired, was
  orphaned), SPA fallback (403/404 → `/index.html`/200 for the History-API router), standard S3
  access logging, CCSF `default_tags`.
- ✅ **Domains: AWS-provided** (`*.cloudfront.net` + `execute-api` URL) for MVP — the domain
  open-question is resolved to *AWS default domains; custom domains (ACM/Route53) deferred*.
- ✅ The deploy job builds the frontend with `VITE_API_BASE="$api_url"`, **`aws s3 sync`s to that
  env's bucket** (`--delete`), then invalidates **only that env's distribution ID** (P6).

**API + compute (built — "Step E"):**
- ✅ **API Gateway v2 HTTP API** ([api.tf](../../infra/modules/app/api.tf)) — one AWS_PROXY integration,
  11 route keys mirroring `backend/scripts/local-api.mjs`, **no authorizer for MVP** (site-code flow
  mints no JWT → requests resolve to `DEMO_SITE_ID`; tenant isolation lands with the deferred JWT
  authorizer + `custom:siteId`), CORS scoped to the CloudFront origin, `$default` stage with
  KMS-encrypted access logs.
- ✅ **api + worker Lambdas** ([lambda.tf](../../infra/modules/app/lambda.tf), nodejs22.x, esbuild-bundled,
  X-Ray active, KMS-encrypted env, reserved concurrency) wired to the existing DynamoDB / S3 / SQS /
  KMS. The worker consumes the submissions queue via an event-source mapping
  (`ReportBatchItemFailures`) with a **DLQ** + redrive.
- ✅ **Least-privilege IAM roles** ([iam.tf](../../infra/modules/app/iam.tf)) — no wildcards.
- ✅ **Analyzer key in Secrets Manager** ([secrets.tf](../../infra/modules/app/secrets.tf)) — secret
  created in Terraform, **value set out-of-band** (never in code/state); the worker fetches it at
  runtime.
- ✅ New env-root outputs: `api_url`, `cloudfront_distribution_id`, `cloudfront_domain_name`.
- **Done when:** each env serves its own frontend from CloudFront and runs the API on Lambda +
  API Gateway, and a deploy invalidates exactly that env's cache. *(✅ **dev applied live 2026-08-18**;
  prod awaits its first release-deploy.)*

> **First-apply fixes (2026-08-18).** The initial dev `apply` surfaced two errors, both fixed:
> (1) the media route key `…/artifacts/{artifactId}:media` was rejected by API Gateway v2 — a
> custom-method colon can't sit on a segment holding a `{param}` (the sibling `artifacts:presign`
> is fine because it's a fully static segment). Reshaped to a `/media` **sub-resource**
> (`…/artifacts/{artifactId}/media`) across the four in-sync spots (api.tf, `backend/src/lambda/api.js`,
> `backend/scripts/local-api.mjs`, `frontend/src/services/api.js`). (2) the `submissions` queue's
> visibility timeout (60s) was below the worker Lambda timeout (120s), which the SQS event-source
> mapping rejects — raised to **720s** (AWS-recommended 6×).

**Deferred follow-ups (tracked):** JWT authorizer + `custom:siteId` issuance + client tokens;
custom domains (ACM + Route53); real `sharp` image downscaling (currently a passthrough); an
optional REGIONAL WAF on the API itself.

## Phase 5 — Branch protection (repo settings)

`dev` protection is **already in place** (PR required + CI must pass). The posture enabled for `main`
(2026-08-18) is intentionally **lighter** than the original draft — see the note below.

**`main` (release branch) — enabled 2026-08-18:**
- ✅ **Pushes restricted to repo admins only.**
- **Deliberately deferred** (not enabled now): require-PR-before-merge, ≥1 approving review,
  CODEOWNERS review, and required `CI` pass on `main`.

> **Single-person path to prod is intentional (2026-08-18).** With `main` unreviewed *and*
> prevent-self-review OFF (P5), one admin can push `main` → cut a `v*` release → self-approve → prod,
> unilaterally. This is a deliberate 2-person-team availability trade, not an oversight: a gate that
> requires a second human fails closed when only one is available. What still stands: prod is
> reachable only via `v*` tags, `main` is admins-only (only the two admins can land code there), every
> deploy carries a **named approver + timestamp** in the environment history, and CI *runs* on `main`
> (not required — check it before approving). **Revisit** both `main` review and prevent-self-review
> when the team grows past two.

**`dev` (integration branch — already enforced):** PR required; CI must pass. Keep as-is.

**Environment protection:**
- `prod` — deployment restricted to **tags `v*`** (✅ set 2026-08-18); **required reviewers = both
  admins** (✅ set 2026-08-18; only one need approve); **prevent-self-review OFF** (P5) so a lone
  admin can deploy. This intentionally drops the two-person control — see the note above.
- `dev` — no gate.

**CODEOWNERS:** **removed 2026-08-18.** With no GitHub teams and `main` locked to the two individual
admin accounts, CODEOWNERS was redundant (the branch lock is the ownership control) and its five
team references didn't resolve. If required review is ever enabled and code-owner review is wanted,
re-add a minimal `.github/CODEOWNERS` naming the two admins' individual handles — not teams.

- **Done (✅ 2026-08-18):** `main` can't be pushed to directly, prod deploys only from `v*` tags and
  pause for a **one-click approval** (required reviewers set; either admin, self allowed). Phase 5
  protection is in place — the SDLC-checklist "branch protections" + "GitHub environments" items can
  flip to done.

## Phase 6 — Rollback runbook (Terraform)

Source of record until enabled, then graduates to `docs/runbooks/rollback.md`. GNP is Terraform, so
rollback is **revert-and-reapply**:

1. Confirm the affected environment + the deploy run that introduced the change.
2. **Revert the offending PR** on `dev` (or cut a rollback PR); let CI pass.
3. For **dev**, the merge auto-redeploys. For **prod**, merge the revert `dev`→`main` and **publish a
   new Release** (e.g. `v…-rollback`) to deploy through the same gated workflow.
4. Re-run the **`/health` smoke test**.
5. **State drift / partial apply:** if an apply half-failed, re-run `terraform apply` to converge;
   only touch state manually (`state rm`/import) with an owner's sign-off and never hand-edit state.
6. Record incident, root cause, follow-up issue.

Avoid out-of-band console changes except in a declared emergency with owner approval — they cause the
drift in step 5.

---

## Hotfixes — the cost of a second long-lived branch

An urgent prod fix still travels the normal path: PR → `dev` (auto-deploys dev, CI green) →
`dev`→`main` merge → publish Release. Only in a **declared emergency** should an admin fast-track a
fix onto `main` directly — and then `dev` must be brought back in sync (merge `main`→`dev`)
immediately, or the branches drift. Prefer the normal path; the emergency bypass is the exception,
not the tool.

---

## What blocks on what

```
admin bootstrap (DONE) ──▶ Phase 1 environments ──▶ Phase 2 remote state ──▶ Phase 3 deploy workflows ──▶ Phase 4 frontend
                                   │                                                  │
                                   └──────────────── Phase 5 branch protection ───────┴──▶ Phase 6 rollback runbook
```

Phases 5 and 6 can be **drafted/merged now**. Phases 1–4 are unblocked (bootstrap is done) and can go
live as soon as the Environments + secrets are set.

## Acceptance criteria (whole plan)

1. Two Terraform env roots (`dev`/`prod`) with remote S3 state + locking.
2. Merges to `dev` auto-deploy dev; PRs run CI (in place).
3. A published Release from `main` → prod **behind a required-reviewer approval pause** (single
   approver; self-review allowed — 2-person availability, P5).
4. Every deploy runs a `/health` smoke test and (frontend) an **env-scoped** CloudFront invalidation.
5. `main` is admins-only + branch-protected (locked to the two admin accounts; PR + CI review
   deferred for a 2-person team, no CODEOWNERS); prod environment is release-tag-restricted; no
   long-lived AWS keys anywhere.
6. A Terraform rollback runbook exists and has been dry-run at least once.

## Open questions

- ~~**Pre-prod / dev hostname**~~ **Resolved 2026-08-18:** both envs use **AWS default domains**
  (CloudFront `*.cloudfront.net` + `execute-api` URL) for MVP. Custom domains (ACM + Route53) are a
  deferred follow-up; when they land, reserve the production hostname for prod only.
- ~~**Do the CODEOWNERS teams exist**~~ **Resolved 2026-08-18: no teams — CODEOWNERS removed.**
  The project is a 2-person repo with no GitHub teams, and `main` is already locked to the two
  individual admin accounts, so CODEOWNERS was redundant *and* referenced five nonexistent teams
  (a latent trap if required review were ever enabled). `.github/CODEOWNERS` deleted; the `main`
  branch lock is the ownership control.
- ~~**Release tag scheme**~~ **Resolved 2026-08-18: semver `vX.Y.Z`.** Release tags follow semantic
  versioning; the leading `v` satisfies the prod Environment's `v*` deployment-tag rule, and
  `git describe` stays legible.
