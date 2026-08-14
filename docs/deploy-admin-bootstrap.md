# Runbook: AWS admin bootstrap for GitHub Actions deploys

**Status:** Ready to hand to the AWS account admin · **Date:** 2026-08-14 ·
[index](./README.md) · companion to [deploy-cicd-plan.md](./deploy-cicd-plan.md)

This is the **one-time scaffolding** an admin/landing-zone owner runs so that
`Mayor-s-Office-of-Innovation/good-neighbor-app` can deploy itself from CI with **no long-lived
AWS keys**. It answers the five "bootstrap contract" facts called out in
[deploy-cicd-plan.md](./deploy-cicd-plan.md#-the-one-blocking-dependency-the-admin-bootstrap-contract)
with a concrete, recommended set of choices. After these steps, every deploy runs through
GitHub Actions via OIDC role assumption.

> **Division of labor.** The **admin** does Steps 1–4 (they need account-admin / IAM
> permissions) and hands back the values in Step 5. The **repo maintainers** then do the
> "After the admin is done" section (GitHub settings + a one-line Terraform backend change) —
> no AWS admin rights required for that part.

The pattern mirrors the OIDC setup used for the `care-connect` deploy repo (GitHub OIDC
identity provider → scoped assumable role → `aws-actions/configure-aws-credentials`), adapted
from that repo's single CloudFormation role to GNP's **Terraform, per-environment** model.

---

## What we're asking you to create (the contract, pre-decided)

The plan lists five open questions; here are the answers we're requesting so you can just
execute. Adjust if account/org policy requires — just tell us what you changed.

| # | Question | Requested answer |
|---|---|---|
| 1 | Scope of bootstrap | Admin creates **all four**: the GitHub OIDC provider, the deploy role(s), **and** the Terraform state bucket + lock table. (State backends can't bootstrap themselves, so they must be admin-created.) |
| 2 | One role or per-env | **One deploy role per environment** (`dev`, `prod`; `staging` later). Separation is at the role, and each is bound to its GitHub Environment. |
| 3 | Read-only plan role | **Yes, one read-only role** for PR `terraform plan` previews (optional but recommended; can be added later without redoing anything). |
| 4 | State layout | **One state bucket, per-env keys.** Bucket `good-neighbor-app-terraform-state`, keys `dev/terraform.tfstate` + `prod/terraform.tfstate`, lock table `good-neighbor-app-terraform-locks`, region `us-west-2`. (These names already appear in the commented backend blocks in the repo.) |
| 5 | Trust-policy scope | Scope each deploy role's trust to **this repo + a GitHub Environment** (`environment:dev`, `environment:prod`). This makes the prod approval gate cryptographically enforced — GitHub won't mint a token for `environment:prod` until the environment's required reviewers approve. The plan role is scoped to **pull requests**. |

**Why environment-scoped trust (fact #5) matters:** GNP's deploy workflow sets
`environment: <env>` on each job, and prod will require reviewer approval. Because the role's
trust condition requires `sub = repo:…:environment:prod`, AWS will only issue credentials for a
job that GitHub has already released past the prod environment's protection rules. No approval →
no OIDC token with that `sub` → no credentials. The gate can't be bypassed from a workflow edit.

---

## Inputs you need from us

| Value | Provided |
|---|---|
| GitHub org / repo | `Mayor-s-Office-of-Innovation/good-neighbor-app` |
| AWS region | `us-west-2` |
| Environments to provision now | `dev`, `prod` (add `staging` later) |
| AWS account ID | _(the account these resources live in — you have this)_ |

Below, `ACCOUNT_ID` = that account's 12-digit ID. All commands assume `us-west-2` and admin
credentials for that account.

---

## Step 1 — Create the GitHub OIDC identity provider (once per account)

If this account already federates GitHub Actions (check IAM → Identity providers for
`token.actions.githubusercontent.com`), **skip this** and reuse the existing provider ARN.

```sh
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

Notes:
- The `client-id-list` value `sts.amazonaws.com` is the audience `configure-aws-credentials`
  requests. Don't change it.
- AWS now validates the GitHub OIDC endpoint against its own trusted CAs, so the thumbprint is
  effectively ignored — the value above is GitHub's well-known thumbprint and is fine to use.
- Record the resulting provider ARN
  (`arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com`).

---

## Step 2 — Create the Terraform remote state backend

State must be admin-created because Terraform can't manage the bucket that stores its own state.
One bucket, per-env keys, one lock table.

```sh
# 2a. State bucket (versioned, encrypted, all public access blocked)
aws s3api create-bucket \
  --bucket good-neighbor-app-terraform-state \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-bucket-versioning \
  --bucket good-neighbor-app-terraform-state \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket good-neighbor-app-terraform-state \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"},"BucketKeyEnabled":true}]}'

aws s3api put-public-access-block \
  --bucket good-neighbor-app-terraform-state \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# 2b. Lock table (on-demand billing; hash key must be named exactly LockID)
aws dynamodb create-table \
  --table-name good-neighbor-app-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-2
```

Please also apply the CCSF cloud tags your org requires to both resources (`Application`,
`ApplicationOwner`, `Environment`, `DataClassification`, `InternetExposure`,
`AssetCriticality`, `Compliance`) — the app's own resources carry these via Terraform, but the
state backend is created outside Terraform so it needs them applied here.

---

## Step 3 — Create one deploy role per environment

Do this once for `dev` and once for `prod` (repeat later for `staging`). Only the **role name**
and the **`sub` value** change between environments.

### 3a. Trust policy (per env)

`trust-dev.json` (for the `prod` role, change both `dev` occurrences to `prod`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:Mayor-s-Office-of-Innovation/good-neighbor-app:environment:dev"
        }
      }
    }
  ]
}
```

```sh
aws iam create-role \
  --role-name good-neighbor-app-deploy-dev \
  --assume-role-policy-document file://trust-dev.json \
  --max-session-duration 3600
```

### 3b. Permissions policy (per env)

The deploy role runs `terraform apply`, so it needs to **create/update/delete** the services the
stack uses, plus read/write its own state. The stack currently provisions: KMS, S3, DynamoDB,
SQS, Cognito, CloudFront (response-headers policy), and WAFv2 — and will soon add Lambda, API
Gateway, IAM roles, and CloudWatch Logs (the analysis Lambdas). Least-privilege IAM for a
Terraform runner is a known hard problem; the recommended posture is a **bounded-broad
customer-managed policy** now, tightened to least-privilege as a Stage 2 follow-up (tracked in
the SDLC plan).

Attach a customer-managed policy `good-neighbor-app-deploy` with these statements (same policy
can be attached to both env roles):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformState",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": [
        "arn:aws:s3:::good-neighbor-app-terraform-state",
        "arn:aws:s3:::good-neighbor-app-terraform-state/*"
      ]
    },
    {
      "Sid": "TerraformLock",
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:us-west-2:ACCOUNT_ID:table/good-neighbor-app-terraform-locks"
    },
    {
      "Sid": "AppResources",
      "Effect": "Allow",
      "Action": [
        "kms:*", "s3:*", "dynamodb:*", "sqs:*", "cognito-idp:*",
        "cloudfront:*", "wafv2:*", "lambda:*", "apigateway:*", "logs:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PassRoleToAppServices",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-*",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": ["lambda.amazonaws.com", "apigateway.amazonaws.com"]
        }
      }
    },
    {
      "Sid": "ManageAppIamRoles",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:TagRole", "iam:UntagRole",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy",
        "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies", "iam:CreatePolicy", "iam:DeletePolicy",
        "iam:GetPolicy", "iam:GetPolicyVersion", "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion", "iam:ListPolicyVersions"
      ],
      "Resource": [
        "arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-*",
        "arn:aws:iam::ACCOUNT_ID:policy/good-neighbor-app-*"
      ]
    }
  ]
}
```

> **If you want to unblock `dev` in five minutes** and tighten later: attach the AWS-managed
> `AdministratorAccess` to the **dev** role only, and use the scoped policy above for **prod**.
> We're fine either way — just note which you chose so we document the actual posture.

Repeat 3a + 3b with `prod` in place of `dev` for the `good-neighbor-app-deploy-prod` role.

---

## Step 4 — (Optional, recommended) Read-only plan role for PR previews

Lets PRs show a `terraform plan` diff without any write access. Trust is scoped to **pull
requests** on this repo, and permissions are read-only + state access.

`trust-plan.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:Mayor-s-Office-of-Innovation/good-neighbor-app:pull_request"
        }
      }
    }
  ]
}
```

```sh
aws iam create-role \
  --role-name good-neighbor-app-plan \
  --assume-role-policy-document file://trust-plan.json \
  --max-session-duration 3600

# Read-only app inspection + read/write on state (plan needs the state lock)
aws iam attach-role-policy \
  --role-name good-neighbor-app-plan \
  --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess
```

The plan role also needs the `TerraformState` + `TerraformLock` statements from Step 3b
(attach them as an inline policy on `good-neighbor-app-plan`), since `terraform plan` reads
state and takes the lock.

---

## Step 5 — Hand these values back to us

Once the above exists, send the maintainers (in any secure channel — these are ARNs/names, not
secrets, but keep them internal):

```text
OIDC provider ARN : arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com
Region            : us-west-2
State bucket       : good-neighbor-app-terraform-state
Lock table         : good-neighbor-app-terraform-locks
dev deploy role    : arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-deploy-dev
prod deploy role   : arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-deploy-prod
plan role (if made): arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-plan
Permissions posture: (scoped policy on both, or Admin-on-dev — tell us which)
```

---

## After the admin is done (repo maintainers, no AWS admin rights needed)

1. **Create the GitHub Environments** (repo → Settings → Environments): `dev` and `prod`.
   - `prod`: add **required reviewers** (the two admins) and turn on **"prevent self-review."**
   - `dev`: no gate.
2. **Set per-environment secret + variable** in each Environment (matches the existing
   [deploy.yml](../.github/workflows/deploy.yml), which reads `secrets.AWS_DEPLOY_ROLE_ARN` and
   `vars.AWS_REGION`):
   - Secret `AWS_DEPLOY_ROLE_ARN` → that env's deploy role ARN.
   - Variable `AWS_REGION` → `us-west-2`.
   - (If the plan role was created, set repo-level secret `AWS_DEV_PLAN_ROLE_ARN` for the
     PR-plan job when Phase 2 of the deploy plan lands.)
3. **Enable the S3 backend** in Terraform: uncomment the `backend "s3"` block in
   [infra/environments/dev/main.tf](../infra/environments/dev/main.tf) and
   [infra/environments/prod/main.tf](../infra/environments/prod/main.tf) (the values already
   match Step 2/4). First `terraform init` migrates local state to S3:
   ```sh
   cd infra/environments/dev && terraform init -migrate-state
   ```
4. **Verify OIDC works** before a real apply — run this throwaway job (Actions → new workflow,
   or a scratch branch) to confirm role assumption + region:
   ```yaml
   name: OIDC smoke test
   on: workflow_dispatch
   permissions: { id-token: write, contents: read }
   jobs:
     verify:
       runs-on: ubuntu-latest
       environment: dev
       steps:
         - uses: aws-actions/configure-aws-credentials@v4
           with:
             role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
             aws-region: ${{ vars.AWS_REGION }}
         - run: aws sts get-caller-identity
   ```
   A green run printing an `AROA…:…` assumed-role identity means the federation is wired
   correctly. Delete the smoke-test workflow afterward.
5. From there, the existing **Deploy** workflow (`workflow_dispatch` → pick `dev`/`prod`) can
   run a real `terraform apply`, and the gated tag-based promotion in
   [deploy-cicd-plan.md](./deploy-cicd-plan.md) (Phases 2–4) can be built on top.

---

## Security notes for the admin

- **No long-lived keys.** Do not create an IAM user or access keys for CI. OIDC role assumption
  is the whole point.
- **Scope stays tight on trust, broad only on permissions.** The trust policy `sub` conditions
  (exact repo + environment / pull_request) are what prevent another repo — or a fork — from
  assuming these roles. Keep those exact-match; don't loosen to a wildcard repo.
- **Prod approval is enforced by the `environment:prod` trust condition**, not just by workflow
  YAML. Keep the prod role's `sub` bound to `environment:prod`.
- **Tightening permissions is a tracked follow-up**, not a launch blocker — the SDLC Stage 2
  plan calls for narrowing these grants (per-resource ARNs, scoped KMS/S3) once the resource set
  stabilizes.
```