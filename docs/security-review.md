# Security Review

Status: in progress — testing-phase data-handling decision recorded (2026-08-12); go-live evidence not started.

## Scope

- Frontend static web app hosted on AWS.
- API Gateway and Lambda handlers.
- SQS asynchronous processing.
- Analysis API (a standalone shared service — ours to own/deploy, also consumed by streetconditions.org) — our Lambda authenticates as a consumer via an **API key** held in Secrets Manager (revised 2026-08-13; was IAM/SigV4).
- DynamoDB (single-table) via the AWS SDK.
- S3 storage — analytics export bucket only. **No photo staging bucket** (dropped 2026-08-13; images post base64-inline through our Lambda — see data-handling note below).
- Cognito authentication and authorization.
- Terraform and GitHub Actions deployment pipeline.

## Data classification & photo handling — no media at rest (revised 2026-08-13)

**Superseded (2026-08-12 → 2026-08-13).** The original design staged captured photos in a
transient S3 bucket and deferred deletion/lifecycle to a post-MVP retention pass (disposable test
data, wiped between cycles). That staging bucket has been **dropped**
([D1](gnp-frontend-migration-plan.md)): Bedrock's 5 MB image cap made a bucket + presigned upload
low-value, so the client posts each image **base64-inline through our Lambda**, which relays it to
the analyzer and returns the result. (Binding size limit is Lambda's ~6 MB sync payload → the
client downscales before posting.)

**Result — person-images are never at rest.** With no bucket and `storage.store_input:false` +
`return_signed_urls:false` on every analyzer call, images exist only **transiently in-memory** for
the request. The "no person-images at rest → Level 2" property is now **delivered directly**, not
deferred — this removes the photo half of the post-MVP retention pass.

**Controls that apply during testing (and after):**

- [ ] Analyzer calls always send **`store_input:false` + `return_signed_urls:false`** (analyzer keeps no copy).
- [ ] **No request-body logging** — the base64 image is not captured in API Gateway exec/access logs or our Lambda logs.
- [ ] Analyzer-account **Bedrock model-invocation logging is OFF** (confirm with the service owner).
- [ ] **Posted-image validation** in the Lambda before the analyzer call: magic-byte / content-type sniff, size cap, per-check artifact-count cap.
- [ ] **TLS-only** on both hops (client→Lambda, Lambda→analyzer).

**Before go-live / any real (non-test) user data:** re-review this classification against the
as-built handler — confirm no incidental persistence or logging of image bytes anywhere in the
path. No S3 photo-retention rules are needed because no photo bucket exists.

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
already specified in [dynamodb-data-model.md](dynamodb-data-model.md) (§ Identity model): an
Admin registers a device once during site setup; the device receives **short-lived STS
credentials carrying a `custom:siteId` claim**; API calls are **SigV4-signed**; the write
handler derives `siteId` **from the claim**; and `dynamodb:LeadingKeys = SITE#<siteId>` pins
every write to that partition. This *structurally* prevents cross-site pollution — a
compromised device can, at worst, affect its own site.

Rejected alternatives: **guest Cognito Identity Pool** (open to anyone — enables throttling
but no real scoping, so it does not stop pollution); **onboarding-minted signed token**
(Option 4 — a viable *lighter fallback* only if device provisioning slips, but it is a bearer
token on a shared device; blast radius one site, mitigated by short expiry + rotation +
revocation).

**Shared dependency.** Option 3 needs a **device-provisioning / credential-vending backend**
(invite codes + STS cred vending). This is the same building block the transcription workstream
needs ([MVP-TODO](MVP-TODO.md)) — track it as a **shared dependency**, not transcription-only.

**Demo vs real-data posture.**

- *Demo / MVP (disposable test data):* device identity may be deferred; the endpoint runs
  **deterrence-grade** (WAF + API Gateway throttling) **plus** the cross-cutting hardening
  below. Residual pollution risk is **accepted** because test data is wiped wholesale between
  cycles (consistent with the photo-handling decision above).
- *Before any real (non-test) data:* **Option 3 must be implemented** (ties to Phase 6 tenant
  isolation, [MVP-TODO](MVP-TODO.md)) and this section re-reviewed.

**Cross-cutting hardening** (applies regardless of identity phase — do these now where cheap):

- [ ] Write handler **derives `siteId` from the principal**, never from the request body (the
  invariant above) — do this even in the demo wherever a principal exists.
- [ ] **Validate the posted image in the Lambda before calling the analyzer**: magic-byte /
  content-type sniff (is it really an image?), size cap (reject oversized base64 bodies), per-check
  artifact-count cap. Direct mitigation for "unwanted images" and oversized payloads — this is the
  control that replaces the dropped presigned-PUT constraints.
- [ ] **Artifacts attach only to a check the same principal created** (conditional write) — no
  grafting images onto another device's check.
- [ ] **Rate-limit per identity + per site** (WAF rate rules + API Gateway usage plans) to cap
  analyzer/Bedrock spend and volume.

**Doc reconciliation.** [D1](gnp-frontend-migration-plan.md) previously described only the
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
- [ ] Dataset-pollution controls verified: device-as-site auth (Option 3), server-derived `siteId` + `LeadingKeys`, posted-image validation (magic-byte + size + count caps), per-site rate limits.
- [ ] Mozilla Observatory A+.
- [ ] SSL Labs A+.
- [ ] Accessibility review passed.
- [ ] Core Web Vitals passed.
