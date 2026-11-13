# ADR 0022: Reusable enrollment invitations

## Status

Accepted (2026-11-12). Supersedes the single-use invitation rules in
[ADR 0015](./0015-device-bindings-and-manager-enrollment.md),
[ADR 0016](./0016-provider-manager-enrollment.md), and
[ADR 0018](./0018-provider-issued-site-invitations.md).

## Context

Email links often open in an embedded browser with storage separate from Safari
or Chrome. Consuming an invitation there stranded its recipient when they opened
it in another browser. An interrupted response could consume the invitation
without saving the credentials anywhere. Smooth access for intended recipients
outweighs preventing reuse of a forwarded invitation within its short lifetime.

## Decision

- Invitation links and manual enrollment codes may establish independent browser
  sessions until the original expiry: eight hours for team/provider-issued Site
  invitations, 24 hours for administrator-issued invitations, and 15 minutes for
  self-service Site Manager recovery. Redemption never extends grant expiry.
- Each redemption creates fresh device bindings using the existing assignment,
  role, and membership. It does not create another person or invalidate another
  browser's session. Provider enrollment still resolves active Sites and commits
  all bindings together.
- Explicit confirmation remains necessary for an invitation link. Simply loading
  it does not enroll a device. A browser with saved access from that exact grant
  checks its session and opens the app without another redemption.
- A lost response can be retried using the same invitation. This is repeatable
  enrollment, not exact-response replay: the retry creates a new binding. Orphaned
  bindings retain the normal inactivity and absolute-expiry limits. Credentials
  are stripped from the URL on load; after a reload before credentials were saved,
  reopen the original invitation or re-enter the code.
- Canonical `pending` and `redeemed` grants are eligible until expiry; cancelled
  and replaced grants are not. This includes still-valid grants redeemed before
  deployment. Lookup tombstones are diagnostic metadata, never authorization.
  List APIs expose eligible grants as `pending` for existing clients; `redeemedAt`
  and redemption audits retain use evidence. Singleton pointers remain until
  cancellation, replacement, or expiry, so used invitations remain manageable.
- Every use revalidates current Site, membership, issuer, and physical-device
  authority. New Site grants snapshot Site credential generation; new Site
  Manager and recovery grants also snapshot membership generation. Transaction
  conditions prevent a concurrent cancellation or authority change from being
  ignored. Historical grants without these snapshots retain their existing
  current-authority checks; no migration invents missing historical generations.
- Invitation cancellation prevents future enrollment; it does not sign out
  existing browsers. Device/session revocation affects that device/session, while
  membership removal invalidates access derived from the assignment. When ending
  a person's access, remove their assignment and cancel any outstanding team
  invitations. A still-valid bearer invitation can enroll another browser even
  after an individual browser session was revoked.
- Rotating refresh tokens and Home Screen handoff grants retain their existing
  single-use and recovery behavior. Webviews keep the dismissible warning and
  install-offer suppression, with no enrollment block.

## Consequences and verification

Forwarding a valid invitation can grant its recipient the same role. The short
original lifetime, cancellation controls, live authority checks, existing code
attempt limits, and enrollment audit/security notifications remain safeguards.
No additional email verification step is introduced.

`npm run test:sessions -w backend` exercises real isolated DynamoDB transactions:
link/code reuse, independent authorization, concurrent redemption and retry,
expiry, authority removal/generation changes, and cancellation after use.
`e2e/recovery-tests/reusable-invitation.spec.js` covers browser behavior in Chromium
and WebKit, alongside the webview warning tests. Backend unit tests cover issuance,
replacement, cancellation, code lookup, and all enrollment scopes.
