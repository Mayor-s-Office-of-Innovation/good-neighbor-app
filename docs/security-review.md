# Security Review

Status: in progress — testing-phase data-handling decision recorded (2026-08-12); go-live evidence not started.

## Scope

- Frontend static web app hosted on AWS.
- API Gateway and Lambda handlers.
- SQS asynchronous processing.
- Analysis API (a standalone shared service — ours to own/deploy, also consumed by streetconditions.org) — our Lambda authenticates as a consumer via an **API key** held in Secrets Manager (revised 2026-08-13; was IAM/SigV4).
- DynamoDB (single-table) via the AWS SDK.
- S3 storage — the **analytics export bucket** and the **media bucket** (GNP-owned; captured photos at rest, five-minute presigned PUT/GET, state-based retention, and server-side validation).
- Cognito authentication and authorization.
- Terraform and GitHub Actions deployment pipeline.

## Data classification & media handling — GNP-owned bucket, ~7-day lifecycle (revised 2026-08-13 PM)

**Supersedes the 2026-08-13 "no media at rest" note.** The interim design dropped the media bucket
and posted images base64-inline from the client. That is **reversed** (D1/D3):
captured media is uploaded via **presigned PUT to an S3 bucket GNP owns**, the backend reads it back
to call the analyzer, and S3 lifecycle rules expire accepted media after seven days (with shorter
windows for pending, rejected, and unprocessed media). Drivers: **large-upload
support** (presigned PUT bypasses the Lambda ~6 MB payload ceiling), **admin review of AI output
against the source media** (the product driver), and **GNP owning retention** (our KMS key +
lifecycle window, changeable at will). This also matches the deployed origin app
`../street-conditions`, which stores media in S3.

**What is at rest.** Person-images live in **GNP's KMS-encrypted bucket**. Declarative lifecycle
rules expire pending/rejected media after one day, registered media after two days, accepted media
after seven days, and noncurrent media versions after one day. DynamoDB stores the **analysis document + the S3 key**
(the scorecard is `sensitive`; the key is a pointer, not PII). This is a step **up** in data-at-rest
exposure from the no-media design and puts a **photo-retention control in scope**.

**The analyzer keeps no copy, and never touches our bucket.** Bedrock (behind the analyzer) accepts
**base64 sources only** — no URL/S3 input path — so the analyzer is given **no presigned URL and no
cross-account IAM grant**. Our worker reads our own bucket with its execution-role IAM, downscales,
base64-encodes, and calls the analyzer with `storage.store_input:false` + `return_signed_urls:false`.
The **only** durable copy of the media is GNP's.

**Controls that apply during testing (and after):**

- [x] **Media bucket hardened:** block-public-access, **SSE-KMS** (app key),
  **worker/Lambda-role-only** access (no public/cross-account read) — *in place*.
- [x] **State-based media expiration** as the retention backstop — implemented in Terraform.
- [x] **Presigned URLs scoped + short-lived:** PUT scoped to `content-type`, declared size, exact unpredictable key, no-overwrite semantics, and five-minute expiry
  (upload); GET minted on-demand for admin review only. No long-lived bucket access to any client.
- [ ] Analyzer calls always send **`store_input:false` + `return_signed_urls:false`** (analyzer keeps no copy).
- [ ] **No media bytes on SQS** — enqueue the **S3 key**, not the bytes.
- [ ] **No request/media-body logging** — the base64 image is not captured in API Gateway exec/access
  logs, our Lambda/worker logs, or (analyzer-account) Bedrock model-invocation logs.
- [x] **Uploaded-media validation** before the analyzer call: independent byte/decode/type checks,
  size/dimension/page caps, metadata-stripping re-encode, and per-check/device/Site/global budgets.
- [x] **TLS-only** for the uploads bucket through an explicit `aws:SecureTransport = false` deny.

**Before go-live / any real (non-test) user data:** re-review this classification against the
as-built path — confirm the lifecycle rules are active in the target account, confirm the bucket is private + KMS-encrypted, no incidental
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

> **`siteId` is always server-derived from a verified principal. The client never
> asserts its own Site on a protected write. Exact media keys are also server-owned.**

**Decision — the device is authenticated as a Site binding.** The implemented model is
[ADR 0010](./adr/0010-device-token-auth.md): enrollment creates a bounded Site binding and
short-lived access token; the authorizer checks current device/binding/Site generations and
passes the verified Site claim to handlers. Handlers build tenant keys from that claim. A
caller-dynamic `LeadingKeys` condition is not available on the shared Lambda execution role;
the reason and possible separate-data-plane hardening are recorded in the data-model document.

Rejected alternatives: **guest Cognito Identity Pool** (open to anyone — enables throttling
but no real scoping, so it does not stop pollution); **onboarding-minted signed token**
(Option 4 — a viable *lighter fallback* only if device provisioning slips, but it is a bearer
token on a shared device; blast radius one site, mitigated by short expiry + rotation +
revocation). Option 4 was realized as that fallback in
[ADR 0010](./adr/0010-device-token-auth.md).

**Cross-cutting hardening** (applies regardless of identity phase — do these now where cheap):

- [x] Write handler **derives `siteId` from the principal**, never from the request body (the
  invariant above) — do this even in the demo wherever a principal exists.
- [x] **Constrain the upload + validate the media before calling the analyzer**: scope the
  **presigned PUT** to `content-type` + size + key prefix, then in the worker do a magic-byte /
  decoded content-type check, size/dimension/page caps, and bounded artifact counts.
  Direct mitigation for "unwanted media" and oversized objects.
- [x] **Artifacts attach only to the exact Site/check/artifact key minted by the server** — no
  cross-Site, cross-check, or alternate-key grafting.
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
- [ ] Dataset-pollution controls verified in the deployed account: binding auth, server-derived `siteId`, negative cross-Site tests, scoped presigned PUT, media validation and quotas, WAF/rate limits, and private SSE-KMS media retention.
- [ ] Mozilla Observatory A+.
- [ ] SSL Labs A+.
- [ ] Accessibility review passed.
- [ ] Core Web Vitals passed.
