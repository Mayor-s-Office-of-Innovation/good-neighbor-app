# ADR 0010: Device auth via site-code-minted HS256 device tokens

## Status

Accepted (2026-09-03, branch `feature/session-security`). Amends the identity
decision in [security-review.md](../security-review.md): that doc adopted
**Option 3** (Cognito device identity + STS/SigV4) with **Option 4** (bearer
token) as the documented *lighter fallback if device provisioning slips*.
Provisioning slipped; Option 4 ships now, exactly as the fallback described.
Option 3 remains the target before any real (non-test) data.

## Context

The device is the shared front-desk tablet. It registers ONCE against the site
code and must never need the code again — the code-holder (a manager) may be
unavailable while workers use the device daily. The demo posture
(deterrence-grade, anonymous writes resolving to `DEMO_SITE_ID`) cannot bound a
registered device to its site, so registration needs to mint a credential that
keeps every later request pinned to one site partition — without waiting on the
Cognito device-provisioning dependency (see security-review.md, "Shared
dependency").

## Decision

Registration and refresh mint **HS256 JWTs on `node:crypto`** (no third-party
JWT dependency), signed with a server-side key:

- **Key management:** `DEVICE_TOKEN_SECRET_SECRET_ARN` in Secrets Manager
  (value set out-of-band, never by Terraform; env var covers local runs).
  Module-scope cached; never logged, never shipped to the client.
- **Two token kinds, one claim shape** (`sub` = deviceId,
  `custom:siteId` = site partition, `ver`, `iat`, `exp`) mirroring the Cognito
  claim contract, so swapping the issuer later is invisible to handlers:
  - *access* — 30 days (`typ: "access"`)
  - *refresh* — 180 days, **single-use**, carries a `jti` (`typ: "refresh"`)
- **Rotation:** refresh tokens rotate on use. A refresh must match the
  `DEVICE#` item's current `refreshJti`; each successful refresh bumps
  `tokenGeneration`, which also kills the previous access token immediately.
- **Revocation:** bump `tokenGeneration` (or delete the device). The
  authorizer's live `GetItem` check makes a still-cryptographically-valid token
  dead instantly; API Gateway's 60 s verdict cache is the propagation bound.
- **Routing:** `POST /v1/devices` (register) and
  `POST /v1/devices/token:refresh` are the only device routes reachable
  anonymously; everything else attaches a REQUEST authorizer
  (`backend/src/lambda/authorizer.js`) that verifies signature + expiry + live
  revocation state and injects the Cognito-shaped claims handlers read today.

The tenant invariant from security-review.md is unchanged: `siteId` is always
server-derived from the verified token (or the `SITE_CODE#` item at
registration) — the request body never asserts a site.

## Consequences

- **Bearer token on a shared tablet.** The refresh token lives in IndexedDB;
  XSS can exfiltrate it. Blast radius is one site (the invariant holds);
  mitigated by rotation + revocation, accepted for the MVP. This is the risk
  security-review.md flagged for Option 4, now realized deliberately.
- **Known race:** the refresh path's GetItem-then-Update is not atomic; two
  concurrent refreshes with the same token can both pass the `refreshJti`
  check. A conditional write is the fix (tracked on the issue tracker).
- **Open routes need rate limits.** Registration is gated only by a 6-character
  site code, so anonymous brute force is feasible; per-identity rate limiting
  (already a security-review.md hardening item) applies to these routes too.
- **Re-review trigger:** before any real (non-test) data, revisit per
  security-review.md — Option 3 or a documented re-acceptance of this posture.