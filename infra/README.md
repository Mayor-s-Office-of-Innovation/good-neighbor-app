# Infrastructure

Terraform is organized by environment roots and reusable modules. Both env roots use the remote
**S3 backend with DynamoDB locking** (state bucket `good-neighbor-app-terraform-state`, lock table
`good-neighbor-app-terraform-locks`, `us-west-2`) — the backend block is **live** (no longer
commented).

```text
infra/
  environments/
    dev/     # env root: backend "s3" + providers (aws, aws.us_east_1) + module "app"
    prod/
  modules/
    app/     # shared resources, keyed on ${local.name_prefix} (good-neighbor-app-<env>)
```

## Providers — the two-region requirement

Each env root configures **two AWS providers** and passes both into the `app` module:

- the default provider (`var.aws_region`, `us-west-2`) for everything, and
- an aliased **`aws.us_east_1`** provider — **required** because the frontend's
  `aws_wafv2_web_acl` is `scope = "CLOUDFRONT"`, and CloudFront-scoped WAF ACLs **must** be created
  in `us-east-1` regardless of the app's region. The module declares
  `configuration_aliases = [aws.us_east_1]` and pins `provider = aws.us_east_1` on the WAF ACL.

Omitting the `aws.us_east_1` provider (or dropping it from the module's `providers = { … }` map)
fails on first apply.

## What the module provisions

DynamoDB (SSE-KMS, PITR, Streams), the SQS submissions queue + DLQ, the S3 upload + frontend +
access-log buckets, a KMS CMK (with CloudFront-service and CloudWatch-Logs-service grants), Cognito,
the **CloudFront distribution** serving the private frontend bucket via OAC, **API Gateway v2 + the
api/worker Lambdas** (least-privilege IAM, X-Ray, event-source mapping), and a Secrets Manager
secret for the analyzer API key (value set out-of-band). The deploy job (`.github/workflows/deploy.yml`)
bundles the Lambdas before `terraform plan`, then after apply builds/syncs the frontend and
invalidates the env's CloudFront distribution.
