# Security Review

Status: in progress — testing-phase data-handling decision recorded (2026-08-12); go-live evidence not started.

## Scope

- Frontend static web app hosted on AWS.
- API Gateway and Lambda handlers.
- SQS asynchronous processing.
- Analysis API (ours on AWS, separate repo) — Lambda authenticates via IAM/SigV4.
- DynamoDB (single-table) via the AWS SDK.
- S3 storage — including the **transient photo staging bucket** (see data-handling note below).
- Cognito authentication and authorization.
- Terraform and GitHub Actions deployment pipeline.

## Data classification & photo handling — testing phase (decided 2026-08-12)

The server-mediated analyze flow ([D1/D3](gnp-frontend-migration-plan.md)) stages captured
photos in a transient S3 bucket before analysis. The intended data-minimization design is
immediate Lambda deletion after analysis + an S3 lifecycle backstop (incl. noncurrent versions
and delete markers).

**Decision:** for the **initial testing phase**, implementation of photo deletion and all
retention/lifecycle windows is **deferred** ([MVP-TODO](MVP-TODO.md) post-MVP retention pass).
Test photos may persist in the staging bucket and are removed by a **wholesale wipe of all test
data between cycles**. This is accepted **because the data is disposable test data**, on the
condition that the following access controls are in place during testing:

- [ ] Staging bucket **Block Public Access** (all four settings) — bucket contents not publicly browseable.
- [ ] **SSE-KMS** encryption at rest (existing app KMS key).
- [ ] **TLS-only** access (`aws:SecureTransport` deny).
- [ ] **Least-privilege**: only the analyze Lambda's role can read/write; no other principals.
- [ ] No object-content logging (photos not captured in CloudWatch / access logs).

**Before go-live / any real (non-test) user data:** the strict retention rules (immediate
Lambda delete + S3 lifecycle incl. noncurrent versions + delete markers) must be implemented and
this classification **re-reviewed** — the "no person-images at rest" property that keeps us at
Level 2 is not delivered until then.

## API write authorization & dataset-pollution risk (decided 2026-08-12)

**Threat.** The analyzer itself is protected — only our Lambda can call it (IAM/SigV4), never
the client. But the **client→Lambda hop is a public endpoint**. Without a site-scoped caller
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
- [ ] **Constrain the presigned PUT**: `content-length-range`, content-type condition, single
  key, short expiry — the URL can't be reused to dump oversized or arbitrary objects.
- [ ] **Validate the staged object in the Lambda before calling the analyzer**: magic-byte /
  content-type sniff (is it really an image?), size cap, per-check artifact-count cap. Direct
  mitigation for "unwanted images."
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
- [ ] Dataset-pollution controls verified: device-as-site auth (Option 3), server-derived `siteId` + `LeadingKeys`, presigned-PUT constraints, staged-object validation, per-site rate limits.
- [ ] Mozilla Observatory A+.
- [ ] SSL Labs A+.
- [ ] Accessibility review passed.
- [ ] Core Web Vitals passed.
