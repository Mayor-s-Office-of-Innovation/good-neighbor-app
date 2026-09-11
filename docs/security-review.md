# Security Review

Status: in progress — testing-phase data-handling decision recorded (2026-08-12); go-live evidence not started.

## Scope

- Frontend static web app hosted on AWS.
- API Gateway and Lambda handlers.
- SQS asynchronous processing.
- Analysis API (a standalone shared service — ours to own/deploy, also consumed by streetconditions.org) — our Lambda authenticates as a consumer via an **API key** held in Secrets Manager (revised 2026-08-13; was IAM/SigV4).
- DynamoDB (single-table) via the AWS SDK.
- S3 storage — the **analytics export bucket** and the **media bucket** (GNP-owned; captured photos/audio at rest, presigned PUT for upload, presigned GET for admin review; a ~7-day expiration lifecycle rule is **designed but not yet enforced** — see data-handling note below; revised 2026-08-13 PM, reverses the dropped-bucket design).
- Cognito authentication and authorization.
- Terraform and GitHub Actions deployment pipeline.

## Data classification & media handling — GNP-owned bucket, ~7-day lifecycle (revised 2026-08-13 PM)

**Supersedes the 2026-08-13 "no media at rest" note.** The interim design dropped the media bucket
and posted images base64-inline from the client. That is **reversed** (D1/D3):
captured media is uploaded via **presigned PUT to an S3 bucket GNP owns**, the backend reads it back
to call the analyzer, and an **S3 lifecycle rule is designed to expire it after ~7 days** (not yet
enforced — see the status note below). Drivers: **large-upload
support** (presigned PUT bypasses the Lambda ~6 MB payload ceiling), **admin review of AI output
against the source media** (the product driver), and **GNP owning retention** (our KMS key +
lifecycle window, changeable at will). This also matches the deployed origin app
`../street-conditions`, which stores media in S3.

**What is at rest.** Person-images and audio live in **GNP's KMS-encrypted bucket**; the design is
for them to **expire at ~7 days** via a **declarative S3 lifecycle rule** (incl. noncurrent versions
+ delete markers) — no app-level delete code. DynamoDB stores the **analysis document + the S3 key**
(the scorecard is `sensitive`; the key is a pointer, not PII). This is a step **up** in data-at-rest
exposure from the no-media design and puts a **photo-retention control in scope**.

> **Status (2026-08-19): the ~7-day media expiration is NOT yet enforced.** The uploads bucket's
> current lifecycle rule only aborts incomplete multipart uploads (7d) and expires *noncurrent*
> versions (90d) — see [`infra/modules/app/main.tf`](../infra/modules/app/main.tf). **Current media
> objects do not expire; they persist indefinitely.** This is an accepted gap for the
> **proof-of-concept** phase: the app is not handling real user data yet — it's an MVP for user
> feedback. Enforcing current-version expiration + `expired_object_delete_marker` is a **pre-launch
> TODO** and a hard gate before any real user data (see the go-live check below).

**The analyzer keeps no copy, and never touches our bucket.** Bedrock (behind the analyzer) accepts
**base64 sources only** — no URL/S3 input path — so the analyzer is given **no presigned URL and no
cross-account IAM grant**. Our worker reads our own bucket with its execution-role IAM, downscales,
base64-encodes, and calls the analyzer with `storage.store_input:false` + `return_signed_urls:false`.
The **only** durable copy of the media is GNP's.

**Controls that apply during testing (and after):**

- [x] **Media bucket hardened:** block-public-access, **SSE-KMS** (app key),
  **worker/Lambda-role-only** access (no public/cross-account read) — *in place*. (TLS-only is
  **not** yet enforced on this bucket — see the transport item below.)
- [ ] **~7-day media expiration** (current-version `expiration` + `expired_object_delete_marker`) as
  the retention backstop — **not yet implemented** (POC gap; only incomplete-multipart + noncurrent-
  version rules exist today). Pre-launch TODO.
- [ ] **Presigned URLs scoped + short-lived:** PUT scoped to `content-type` + size + key prefix
  (upload); GET minted on-demand for admin review only. No long-lived bucket access to any client.
- [ ] Analyzer calls always send **`store_input:false` + `return_signed_urls:false`** (analyzer keeps no copy).
- [ ] **No media bytes on SQS** — enqueue the **S3 key**, not the bytes.
- [ ] **No request/media-body logging** — the base64 image is not captured in API Gateway exec/access
  logs, our Lambda/worker logs, or (analyzer-account) Bedrock model-invocation logs.
- [ ] **Uploaded-media validation** before the analyzer call: magic-byte / content-type sniff, size
  cap, per-check artifact-count cap.
- [ ] **TLS-only** on every hop (client→S3, client→Lambda, worker→analyzer). **Not in place for
  S3:** the uploads bucket has **no bucket policy at all**, so no `aws:SecureTransport` deny refuses
  non-TLS access — a pre-launch TODO (add an `aws_s3_bucket_policy` denying `aws:SecureTransport =
  false`).

**Before go-live / any real (non-test) user data:** re-review this classification against the
as-built path — **implement and confirm the ~7-day media-expiration lifecycle rule is active** (not
yet done — see the status note above), confirm the bucket is private + KMS-encrypted, no incidental
second copy or media logging exists anywhere, and admin-review presigned GETs are access-controlled.

## API write authorization & dataset-pollution risk (decided 2026-08-12)

**Threat.** The analyzer itself is protected — only our Lambda can call it (it holds GNP's
consumer **API key** server-side, in Secrets Manager), never the client. But the **client→Lambda
hop is a public endpoint**. Without a site-scoped caller
identity, anyone who reaches it can (a) **pollute a site's dataset** with unwanted
checks/images and (b) **drive analyzer/Bedrock cost** through volume. Rate limits and WAF slow
this; they do **not** prevent it.

**Invariant (must never regress).** Pollution of a *specific* site cannot be prevented while
writes are anonymous. Prevention requires — and this is the rule every write path must uphold:

> **`siteId` is always server-derived from a verified principal and enforced by IAM
> `dynamodb:LeadingKeys`. The client never asserts its own site on a write.**

**Decision — Option 3: the device is authenticated as the site.** We adopt the identity model
already specified in [dynamodb-data-model.md](./dynamodb-data-model.md) (§ Identity model): an
Admin registers a device once during site setup; the device receives **short-lived STS
credentials carrying a `custom:siteId` claim**; API calls are **SigV4-signed**; the write
handler derives `siteId` **from the claim**; and `dynamodb:LeadingKeys = SITE#<siteId>` pins
every write to that partition. This *structurally* prevents cross-site pollution — a
compromised device can, at worst, affect its own site.

Rejected alternatives: **guest Cognito Identity Pool** (open to anyone — enables throttling
but no real scoping, so it does not stop pollution); **onboarding-minted signed token**
(Option 4 — a viable *lighter fallback* only if device provisioning slips, but it is a bearer
token on a shared device; blast radius one site, mitigated by short expiry + rotation +
revocation). Option 4 was realized as that fallback in
[ADR 0010](./adr/0010-device-token-auth.md).

**Shared dependency.** Option 3 needs a **device-provisioning / credential-vending backend**
(invite codes + STS cred vending) — track it as a **standalone dependency** of Option 3.

**Demo vs real-data posture.**

- *Demo / MVP (disposable test data):* device identity may be deferred; the endpoint runs
  **deterrence-grade** (WAF + API Gateway throttling) **plus** the cross-cutting hardening
  below. Residual pollution risk is **accepted** because test data is wiped wholesale between
  cycles (consistent with the photo-handling decision above).
- *Before any real (non-test) data:* **Option 3 must be implemented** (ties to Phase 6 tenant
  isolation, on the issue tracker) and this section re-reviewed.

**Cross-cutting hardening** (applies regardless of identity phase — do these now where cheap):

- [ ] Write handler **derives `siteId` from the principal**, never from the request body (the
  invariant above) — do this even in the demo wherever a principal exists.
- [ ] **Constrain the upload + validate the media before calling the analyzer**: scope the
  **presigned PUT** to `content-type` + size + key prefix, then in the worker do a magic-byte /
  content-type sniff (is it really an image/audio?), size cap, and per-check artifact-count cap.
  Direct mitigation for "unwanted media" and oversized objects.
- [ ] **Artifacts attach only to a check the same principal created** (conditional write) — no
  grafting images onto another device's check.
- [ ] **Rate-limit per identity + per site** (WAF rate rules + API Gateway usage plans) to cap
  analyzer/Bedrock spend and volume.

**Doc reconciliation.** D1 previously described only the
"Cognito Identity Pool guest, deterrence-grade" posture; that is the **demo** posture. The
**real-data** posture is Option 3 here, plus the data model's identity model. Both docs now
point here.

## Go-Live Evidence

- [ ] Threat model reviewed.
- [ ] Secrets scan clean.
- [ ] Dependency scan clean or exceptions approved.
- [ ] SAST findings reviewed.
- [ ] Terraform scan findings reviewed.
- [ ] IAM policies reviewed for least privilege.
- [ ] Database encryption and backup settings verified.
- [ ] S3 public access blocks verified.
- [ ] CloudFront security headers verified.
- [ ] WAF rules and rate limits verified.
- [ ] Dataset-pollution controls verified: device-as-site auth (Option 3), server-derived `siteId` + `LeadingKeys`, scoped presigned PUT + uploaded-media validation (magic-byte + size + count caps), per-site rate limits, media bucket private + SSE-KMS + ~7-day expiration lifecycle implemented and active (not yet — pre-launch TODO).
- [ ] Mozilla Observatory A+.
- [ ] SSL Labs A+.
- [ ] Accessibility review passed.
- [ ] Core Web Vitals passed.
