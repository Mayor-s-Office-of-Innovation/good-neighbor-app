# Infrastructure

Terraform is organized by environment roots and reusable modules. Both env roots use the remote
**S3 backend with DynamoDB locking** (state bucket `good-neighbor-app-terraform-state`, lock table
`good-neighbor-app-terraform-locks`, `us-west-2`) — the backend block is **live** (no longer
commented). The dev and prod roots are separate logical environments in AWS account
`518892333858`, with distinct state keys, deploy roles, resource names, and GitHub Environments.
The `dev` branch continues to deploy `dev.goodneighborsf.org`; a published release from `main`
deploys the production app at `goodneighbor.sf.gov` after the `prod` Environment approval.

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

## Production DNS and first application deploy

The existing `prod/terraform.tfstate` in the DEV account already owns the delegated
`goodneighbor.sf.gov` zone (`Z013233314Z835D93KVOT`), its DNSSEC signing, and query logging.
The public delegation points at that zone's four Route 53 nameservers. Do not create a second
zone, migrate or reinitialize this state, or change the parent delegation as part of the
application deployment. The older `gn.sf.gov` zone is also in this state and remains untouched.

Production deployment uses the DEV-account role
`arn:aws:iam::518892333858:role/good-neighbor-app-deploy-prod`. The `prod` GitHub Environment
must have that ARN as `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION=us-west-2`, a required reviewer, and a
selected-ref policy that admits release tags matching `v*`. The workflow checks the AWS account,
the existing hosted-zone ID, and that the saved plan leaves the existing DNS/DNSSEC/logging
resources unchanged. It also verifies that the tagged commit is on `main`.

For the first app deployment, merge reviewed configuration to `main`, create a `v*` tag on a
`main` commit, and run the reusable **Deploy** workflow manually against that tag with
`environment=prod`. A manual production run is **plan-only**: review the Terraform plan summary
and full workflow log before publishing a GitHub Release for the same tag and commit SHA. Publishing
the release runs the normal reviewed production apply and web publish. Do not move the tag after
the preview; do not use a local Terraform apply.

The **Provision goodneighbor.sf.gov DNS zone** workflow is retained for DNS-only recovery; the
zone is already provisioned, so normal application deployment must not run this bootstrap.

The DNS-only recovery workflow itself accepts dispatches from `main` only. If
the `prod` GitHub Environment is restricted to `v*` tags only, that separate
Environment rule will block the recovery workflow. Review the recovery plan
and any temporary Environment-rule change explicitly before rerunning it;
normal releases do not require the DNS bootstrap.

The DNS-only plan includes the hosted zone, DNSSEC signing and its asymmetric
KMS key, plus query logging to an encrypted CloudWatch log group in `us-east-1`
with 365-day retention. The workflow allowlist permits only those eight resources
and only create/no-op actions, with one recovery exception: Terraform may replace
`aws_route53_hosted_zone_dnssec.goodneighbor` after a failed initial signing
attempt leaves that toggle resource tainted and `NOT_SIGNING`. This exception is
safe only before DT publishes the parent DS record; it does not replace the hosted
zone, KMS keys, or key-signing key. Other changes to existing resources require a
normal reviewed infrastructure deployment.

The four `goodneighbor_dns_name_servers` are already delegated by `sf.gov`.
The zone is signing, but the parent DS record has not yet been published.
Coordinate publication of `goodneighbor_dnssec_ds_record` with DT as a separate
DNSSEC change, after confirming its value and the parent process. Signing alone
does not establish the parent trust chain. The recovery workflow reports both
outputs but does not publish the parent DS record.

The earlier `gn.sf.gov` hosted zone is retained as protected infrastructure until
its retirement is separately reviewed. Its nameservers are not valid for
`goodneighbor.sf.gov`.

The production provider app is served only from `goodneighbor.sf.gov`; the production
CloudFront distribution does not claim the legacy `goodneighborsf.org` apex. The legacy
`goodneighborsf.org` hosted zone (`Z0308170YNRHEPQH0O3C`, AWS account `701893741736`)
remains outside both app Terraform roots and continues to hold the
`dev.goodneighborsf.org` delegation and SES DKIM records for
`codes@goodneighborsf.org`. SF Mayor's Office of Innovation coordinates changes to
that zone; do not remove or repoint it.

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
