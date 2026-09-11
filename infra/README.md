# Infrastructure

Terraform is organized by environment roots and reusable modules. Both env roots use the remote
**S3 backend with DynamoDB locking** (state bucket `good-neighbor-app-terraform-state`, lock table
`good-neighbor-app-terraform-locks`, `us-west-2`) — the backend block is **live** (no longer
commented).

## State backend protection

The shared state bucket is managed outside these environment roots in AWS account
`518892333858`. On 2026-09-11, a read-only check with the owning account's
`nst-dev` profile confirmed that S3 versioning is `Enabled`:

```bash
aws s3api get-bucket-versioning \
  --bucket good-neighbor-app-terraform-state \
  --expected-bucket-owner 518892333858 \
  --profile nst-dev
# { "Status": "Enabled" }
```

This is a dated verification of the externally managed bucket, not a resource
owned by the application Terraform. Both environments retain their existing
state keys (`dev/terraform.tfstate` and `prod/terraform.tfstate`), encryption,
and DynamoDB locking. Verify versioning again when changing backend ownership
or configuration; do not recreate the shared bucket in an application root.

## Production DNS bootstrap

The **Provision gn.sf.gov DNS zone** workflow must be dispatched from `main`.
It checks out the immutable commit recorded by that dispatch. The `prod`
GitHub Environment is the external enforcement boundary: its selected-ref
policy allows the `main` branch and the existing `v*` release tags, with required
reviewer approval retained. Other branches and tags are rejected. The DNS
workflow itself rejects tag dispatches; release tags remain available to the
normal production release workflow. Merging to `dev` does not run this workflow.

The DNS-only plan includes the hosted zone, DNSSEC signing and its asymmetric
KMS key, plus query logging to an encrypted CloudWatch log group in `us-east-1`
with 365-day retention. The workflow allowlist permits only those eight resources
and only create/no-op actions; changes to existing resources require a normal
reviewed infrastructure deployment.

After applying, provide DT all four `gn_dns_name_servers`. Once delegation and
zone signing are confirmed, coordinate publication of `gn_dnssec_ds_record` in
`sf.gov` to establish the DNSSEC chain of trust. Signing alone does not establish
that parent trust. The workflow summary reports both outputs.

The DNSSEC key uses `ECC_NIST_P256` / `SIGN_VERIFY`, as required by Route 53.
KMS automatic rotation is unsupported for this asymmetric key (the resource's
single Checkov rotation exception documents this limitation). Rotate using a
coordinated Route 53 KSK and parent DS rollover with DT; never disable or remove
the old signing key while the parent still references it. The query-log
encryption key is symmetric and has automatic rotation enabled.


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
