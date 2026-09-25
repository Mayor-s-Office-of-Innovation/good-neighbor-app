# Infrastructure

Terraform is organized by environment roots and reusable modules. Each AWS account owns its own
remote **S3 backend with DynamoDB locking** in `us-west-2`:

- DEV account: bucket `good-neighbor-app-terraform-state`, lock table
  `good-neighbor-app-terraform-locks`, key `dev/terraform.tfstate`.
- PROD account: bucket and lock-table names are supplied by the `prod` GitHub Environment;
  application key `app/terraform.tfstate` and bootstrap key `bootstrap/terraform.tfstate`.

The PROD backend resources are declared in `infra/bootstrap/prod-state`; the application root does
not own or destroy its own backend.

## State backend protection

The DEV state bucket is managed outside the application environment root in the DEV AWS account.
On 2026-09-11, a read-only check with the owning account's
`nst-dev` profile confirmed that S3 versioning is `Enabled`:

```bash
aws s3api get-bucket-versioning \
  --bucket good-neighbor-app-terraform-state \
  --expected-bucket-owner "$AWS_ACCOUNT_ID" \
  --profile nst-dev
# { "Status": "Enabled" }
```

This is a dated verification of the externally managed DEV bucket, not a resource
owned by the application Terraform. Verify versioning again when changing backend ownership
or configuration; do not recreate it in an application root.

### One-time PROD backend bootstrap and state migration

Both workflows below are manual, accept dispatches only from `main`, use GitHub Environment
approval, and verify the exact AWS account before making changes. Terraform apply runs only in CI.
Each GitHub Environment must define the `AWS_ACCOUNT_ID` secret and the `AWS_REGION`,
`TF_STATE_BUCKET`, and `TF_LOCK_TABLE` variables. PROD must additionally define
`TF_STATE_LOG_BUCKET` and `TF_STATE_KMS_KEY_ALIAS`. The alias is resolved to the key ARN at runtime,
and every PROD backend initialization supplies that ARN as `kms_key_id`. These values are
deliberately not committed.
Set `TF_STATE_KMS_KEY_ALIAS` to `alias/good-neighbor-app-prod-terraform-state`.

1. Run **Bootstrap production Terraform backend**. It creates only the allowlisted KMS key, S3
   state and access-log buckets, and DynamoDB lock table in PROD, then immediately migrates its bootstrap state
   from the runner into `bootstrap/terraform.tfstate`. It refuses to run if the bucket or lock
   table already exists, so a partial failure must be inspected rather than blindly retried.
2. Record the exact version ID and lineage of the repaired DEV-hosted source object. The source is
   retained as rollback evidence; the migration does not delete it:

   ```bash
   aws s3api list-object-versions \
     --bucket "$TF_STATE_BUCKET" \
     --prefix prod/terraform.tfstate \
     --expected-bucket-owner "$AWS_ACCOUNT_ID" \
     --query 'Versions[?IsLatest].[VersionId,LastModified]' \
     --output table
   ```

3. Run **Migrate production application state** with that exact version ID and the expected
   lineage. The DEV job exports only that immutable S3 version. It rejects the file unless it has
   zero managed resources and contains only the known public DNS outputs and caller-identity data.
   The PROD job refuses to overwrite an existing destination, then writes the verified state to
   `app/terraform.tfstate`. Terraform may assign the fresh destination backend a new lineage; the
   workflow records both lineages and confirms the destination's zero-managed-resource invariant
   and exact non-sensitive DNS metadata inventory.
4. Run the normal production Terraform plan. Confirm it proposes the PROD application resources,
   including `goodneighbor.sf.gov`, and does not propose `gn.sf.gov` resources before approving an
   apply.

The temporary cross-job artifact is retained for one day. GitHub environment secrets provide a
different `AWS_DEPLOY_ROLE_ARN` in each job: the export job uses `dev`; the migration job uses
`prod`. Never use the DEV role to create or operate the PROD backend.

## Production DNS bootstrap

The **Provision goodneighbor.sf.gov DNS zone** workflow must be dispatched from `main`.
It checks out the immutable commit recorded by that dispatch. The `prod`
GitHub Environment is the external enforcement boundary: its selected-ref
policy allows the `main` branch and the existing `v*` release tags, with required
reviewer approval retained. Other branches and tags are rejected. The DNS
workflow itself rejects tag dispatches; release tags remain available to the
normal production release workflow. Merging to `dev` does not run this workflow.

The DNS-only plan includes the hosted zone, DNSSEC signing and its asymmetric
KMS key, plus query logging to an encrypted CloudWatch log group in `us-east-1`
with 365-day retention. The workflow allowlist permits only those eight resources
and only create/no-op actions, with one recovery exception: Terraform may replace
`aws_route53_hosted_zone_dnssec.goodneighbor` after a failed initial signing
attempt leaves that toggle resource tainted and `NOT_SIGNING`. This exception is
safe only before DT publishes the parent DS record; it does not replace the hosted
zone, KMS keys, or key-signing key. Other changes to existing resources require a
normal reviewed infrastructure deployment.

After applying, provide DT all four `goodneighbor_dns_name_servers`. Once
delegation and zone signing are confirmed, coordinate publication of
`goodneighbor_dnssec_ds_record` in `sf.gov` to establish the DNSSEC chain of
trust. Signing alone does not establish that parent trust. The workflow summary
reports both outputs.

The earlier `gn.sf.gov` hosted zone and its DNS controls remain in the DEV
account pending a separately reviewed retirement. They are deliberately absent
from the PROD Terraform root and PROD state: production workflows must not
recreate or manage them. Their name servers are not valid for
`goodneighbor.sf.gov`.

The PROD root does not read DEV Terraform state. The public DEV delegation name
servers and SES Easy DKIM tokens are explicit, validated PROD inputs. When DEV
rotates either value, update the corresponding PROD input through a reviewed
handoff before applying the parent-zone records.

The production provider app is served canonically from `goodneighbor.sf.gov`.
During the hostname transition, `goodneighborsf.org` remains a second alias on
the same production CloudFront distribution. The legacy `goodneighborsf.org`
hosted zone also continues to own the `dev.goodneighborsf.org` delegation and
the SES DKIM records for `codes@goodneighborsf.org`; do not remove that zone when
the legacy production web alias is eventually retired.

The DNSSEC key uses `ECC_NIST_P256` / `SIGN_VERIFY`, as required by Route 53.
KMS automatic rotation is unsupported for this asymmetric key (the resource's
single Checkov rotation exception documents this limitation). Rotate using a
coordinated Route 53 KSK and parent DS rollover with DT; never disable or remove
the old signing key while the parent still references it. The query-log
encryption key is symmetric and has automatic rotation enabled.


```text
infra/
  bootstrap/
    prod-state/ # one-time PROD-owned backend root
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
