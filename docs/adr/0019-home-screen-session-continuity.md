# ADR 0019: Browser and Home Screen sessions under one managed device

## Status

Accepted (2026-10-27). Supersedes the Home Screen handoff portion of
[ADR 0010](./0010-device-token-auth.md).

## Context

iOS Home Screen apps do not inherit Safari's IndexedDB credentials. The former
handoff depended on Safari capturing a dynamically replaced blob manifest, and
redemption rotated Safari's credentials. Generic login bookmarks also bypassed
stored sessions, and separate tabs could race to spend one refresh token.

## Decision

Handoff preparation sets a path-scoped `__Secure-gnp-handoff` cookie holding a
single-use grant. It is Secure, HttpOnly, SameSite=Strict, host-only, and expires
with the grant (at most seven days). iOS 17.2 and later copy cookies when
installing a Home Screen app; see [WebKit's release notes](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).
The manifest fragment remains a compatibility fallback. Enrollment waits at most
five seconds for preparation; failed preparation does not block enrollment.

Redemption atomically consumes the grant and adds an independent session to the
existing `DEVICE#` record. It creates no new device, canonical binding, physical
identity, or provider enrollment. Existing tokens without `sid` use the primary
session's generation and refresh JTI. New Home Screen tokens carry a signed `sid`
and use that slot's generation and single-use refresh JTI. Existing slots rotate
with conditional nested updates; creation conditionally replaces the bounded map
(maximum eight live Home Screen sessions per Site binding). Expired or signed-out
slots are reclaimed when creating a new session. Each slot expires after 30 days
without refresh, bounded by the device's absolute expiry.

Every session is checked against the parent device, binding, Site, and applicable
membership authority. Site switching retains the same session ID on the target
binding and rotates only that context. All existing managed-device, provider
enrollment, Site-wide, and membership revocation controls cover every context.
Revocation changes parent status or authority generations; editing only a primary
session generation is not a device-wide revocation procedure.

Managers see one labeled device with a Sessions disclosure showing Browser and
Home Screen app, status, and last refresh activity. The display hint is not an
authorization boundary. Browser tabs sharing storage share one session; these
are container sessions, not individual tabs. Older records default to Browser.
Only sanitized session summaries are returned by the list API.

Explicit sign-out ends only the current session and clears its installation
cookie. Browser sign-out also retires its pending handoff pointer; conditional
issuance cannot restore that pointer after sign-out. Client sign-out cancels
pending preparation and bounds remote cleanup to three seconds. Offline cleanup
is best effort; local credentials are still removed. Device revocation is the
control for removing all access.

A generic login-link flag no longer overrides a stored session. Explicit
enrollment credentials still take precedence. Refresh uses an origin-wide Web
Lock and re-reads IndexedDB after acquiring it. Requests reuse an already-rotated
access token. Without Web Locks, rejected refreshes check for a newer saved
session before requiring login.

## Consequences

Safari and Home Screen remain independently usable under one managed entry.
Revoking that entry disables both; signing out of one preserves the other.
No schema migration or cloud resources are required. Cookie and Set-Cookie
headers must never be logged. The cookie only bootstraps installation; ordinary
API requests still require bearer tokens and current authority.

An older icon installed without a grant or cookie needs fresh sign-in or
reinstallation after Safari prepares the cookie. Automated browser tests simulate
cookie copying; a real iPhone Add to Home Screen check is still required.
`npm run test:sessions -w backend` runs isolated in-memory DynamoDB Local tests
for concurrent refresh, replay, switching, sign-out races, and revocation. It
requires Java and the local harness's DynamoDB Local installation.
