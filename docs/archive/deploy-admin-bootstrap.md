# Runbook: AWS admin bootstrap for GitHub Actions deploys

**Status:** Done → **archived** (2026-08-18). The one-time AWS scaffolding below is complete (OIDC
provider, Terraform state backend, per-env deploy roles) and the maintainer follow-up (GitHub
Environments, secrets, S3 backend enable) is done. Kept for the historical record + the exact CLI /
trust-policy JSON. The living deploy doc is [deploy-cicd-plan.md](../deploy-cicd-plan.md).

This is the **one-time scaffolding** an AWS admin runs so that
`Mayor-s-Office-of-Innovation/good-neighbor-app` can deploy itself from CI with **no long-lived
AWS keys**. After these steps, every deploy runs through GitHub Actions via OIDC role assumption.

---

## Inputs you need

| Value | Provided |
|---|---|
| GitHub org / repo | `Mayor-s-Office-of-Innovation/good-neighbor-app` |
| AWS region | `us-west-2` |
| Environments to provision now | `dev`, `prod` |
| AWS account ID | _(the account these resources live in — you have this)_ |

Below, `ACCOUNT_ID` = that account's 12-digit ID. All commands assume `us-west-2` and admin
credentials for that account.

---

## Step 1 — Grab the GitHub OIDC provider ARN

This account already federates GitHub Actions, so there's nothing to create — just grab the
existing provider ARN and record it for Step 4:

```sh
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn" \
  --output text
```

That prints `arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com`.

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

Apply the required CCSF cloud tags to both resources — the app's own resources carry these via
Terraform, but the state backend is created outside Terraform so it needs them applied here
(`aws s3api put-bucket-tagging` / `aws dynamodb tag-resource`):

```text
Department         = Mayor's Office
DepartmentCode     = MYR
Division           = <your division>
BusinessOwner      = <ISA business signatory email>
BillingCode        = <internal billing code, or "Non-Bill">    # required — MYR is not TIS
CloudType          = Commercial                                # standard aws partition, us-west-2
Environment        = prod                                      # shared backend serves dev+prod; tag prod
DataClassification = internal
InternetExposure   = internal-only
AssetCriticality   = tier-2
```

The three `<…>` values are yours to fill (they're org-specific and not derivable here).

---

## Step 3 — Create one deploy role per environment

Do this once for `dev` and once for `prod`. Only the **role name**
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
SQS, Cognito, CloudFront (response-headers policy), WAFv2, API
Gateway, IAM roles, and CloudWatch Logs. The service list also covers the settled roadmap so this
policy doesn't need a second admin pass: Secrets Manager (analyzer API key, MVP), EventBridge
(6-hour analytics exports, Phase 4), SSM Parameter Store (config), and Route53 + ACM (custom
domain and its TLS certificate).

Attach a customer-managed policy `good-neighbor-app-deploy` with these statements (same policy
can be attached to both env roles):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AppResources",
      "Effect": "Allow",
      "Action": [
        "kms:*", "s3:*", "dynamodb:*", "sqs:*", "cognito-idp:*",
        "cloudfront:*", "wafv2:*", "lambda:*", "apigateway:*", "logs:*",
        "secretsmanager:*", "events:*", "ssm:*", "route53:*", "acm:*"
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
          "iam:PassedToService": [
            "lambda.amazonaws.com", "apigateway.amazonaws.com",
            "events.amazonaws.com", "scheduler.amazonaws.com"
          ]
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
    },
    {
      "Sid": "DenyProtectBootstrap",
      "Effect": "Deny",
      "Action": [
        "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy",
        "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
        "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
        "iam:DeletePolicy", "iam:DeleteOpenIDConnectProvider",
        "iam:UpdateOpenIDConnectProviderThumbprint",
        "iam:AddClientIDToOpenIDConnectProvider",
        "iam:RemoveClientIDFromOpenIDConnectProvider"
      ],
      "Resource": [
        "arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-deploy-*",
        "arn:aws:iam::ACCOUNT_ID:policy/good-neighbor-app-deploy",
        "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      ]
    }
  ]
}
```

**Naming requirement:** every IAM role and policy the Terraform creates **must** be named with the
`good-neighbor-app-` prefix, or `terraform apply` fails with `AccessDenied`.

Repeat 3a + 3b with `prod` in place of `dev` for the `good-neighbor-app-deploy-prod` role.


---

## Step 4 — Hand these values back to us

Once the above exists, send the maintainers (in any secure channel — these are ARNs/names, not
secrets, but keep them internal):

```text
OIDC provider ARN : arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com
Region            : us-west-2
State bucket       : good-neighbor-app-terraform-state
Lock table         : good-neighbor-app-terraform-locks
dev deploy role    : arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-deploy-dev
prod deploy role   : arn:aws:iam::ACCOUNT_ID:role/good-neighbor-app-deploy-prod
Permissions posture: (scoped policy on both, or Admin-on-dev — tell us which)
```

---

## After the admin is done (repo maintainers, no AWS admin rights needed)

1. **Create the GitHub Environments** (repo → Settings → Environments): `dev` and `prod`.
   - `prod`: add **required reviewers** (the two admins); leave **"prevent self-review" OFF** so a
     single admin can approve + deploy when the other is unavailable (a deliberate 2-person-team
     trade — see the plan's P5 decision). Re-enable it when the team grows past two.
   - `dev`: no gate.
2. **Set per-environment secret + variable** in each Environment (matches the existing
   [deploy.yml](../../.github/workflows/deploy.yml), which reads `secrets.AWS_DEPLOY_ROLE_ARN` and
   `vars.AWS_REGION`):
   - Secret `AWS_DEPLOY_ROLE_ARN` → that env's deploy role ARN.
   - Variable `AWS_REGION` → `us-west-2`.
3. **Enable the S3 backend** in Terraform: uncomment the `backend "s3"` block in
   [infra/environments/dev/main.tf](../../infra/environments/dev/main.tf) and
   [infra/environments/prod/main.tf](../../infra/environments/prod/main.tf) (the values already
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
   run a real `terraform apply`, and the branch-and-release promotion in
   [deploy-cicd-plan.md](../deploy-cicd-plan.md) (merge to `dev`→dev, published Release→prod;
   Phases 3–4) can be built on top.

---

## Security notes for the admin

- **No long-lived keys.** Do not create an IAM user or access keys for CI. OIDC role assumption
  is the whole point.
- **The PR path holds no AWS credentials.** [`ci.yml`](../../.github/workflows/ci.yml) grants no
  `id-token: write`, so PR-triggered jobs can't federate to AWS at all — the only AWS-touching
  workflow is the gated Deploy. There is deliberately no read-only plan role (Step 4).
- **Scope stays tight on trust, broad only on permissions.** The trust policy `sub` conditions
  (exact repo + environment / pull_request) are what prevent another repo — or a fork — from
  assuming these roles. Keep those exact-match; don't loosen to a wildcard repo.
- **Prod approval is enforced by the `environment:prod` trust condition**, not just by workflow
  YAML. Keep the prod role's `sub` bound to `environment:prod`.
- **Tightening permissions is a tracked follow-up**, not a launch blocker — the SDLC Stage 2
  plan calls for narrowing these grants (per-resource ARNs, scoped KMS/S3) once the resource set
  stabilizes.
```