# ADR 0020: Retryable recovery of interrupted refresh rotation

## Status

Accepted (2026-10-27). Extends [ADR 0010](./0010-device-token-auth.md) and
[ADR 0019](./0019-home-screen-session-continuity.md).

## Context

A single-use refresh can commit on the server while its response is lost to a
reload, transport interruption, or failed local storage transaction. The browser
then retains an already-spent token. Web Locks serialize live tabs but cannot
recover a rotation after the document is destroyed. A local Quiche incident
showed a successful rotation followed by replay of the old token two seconds
later; its exact client interruption was not observable. Controlled tests now
reproduce both discarded responses and failed IndexedDB writes.

## Decision

Before sending a refresh, the client commits a random UUID v4 attempt ID and its
associated refresh token to the current IndexedDB binding in one transaction.
Concurrent tabs reuse the same attempt for that token, even without Web Locks.
A reload retains it. The request body is `{ refreshToken, attemptId }`.
Only a successful conditional save of the replacement pair clears the attempt.
Late saves cannot overwrite a new enrollment or a different completed rotation.
Storage failure before preparing the attempt prevents the network refresh.

The backend verifies the signed, unexpired refresh token as before. An optional
attempt ID must be a UUID v4. Rotation conditionally writes the next generation,
refresh JTI, activity, and a recovery receipt in the same DynamoDB transaction.
The receipt belongs to the primary session or the specific Home Screen slot,
never to a different container. It stores hashes of the old token and attempt ID,
the expected old and replacement generations/JTI, and an encrypted token pair.
AES-256-GCM uses a domain-separated key derived from the existing token signing
secret, a fresh random IV, and Site/device/session identity as authenticated data.
Credentials and attempt IDs must never be logged. Responses use `no-store`.

A retry requires the original signed token and the exact same attempt ID, within
five minutes of the commit and before that original token expires. It returns
the identical replacement pair, not another rotation. Remaining lifetimes are
reduced by elapsed time; recovery does not extend JWT expiry or session activity.
The encrypted timestamp independently bounds the window. Only one receipt per
session is kept, overwritten on its next retryable rotation. Expired receipts
may remain encrypted in the row; expiry is enforced by the application, not
DynamoDB's eventual TTL deletion. No table migration, new IAM action, or cloud
resource is required.

Each recovery uses strongly consistent device, Site, and applicable membership
reads. Parent liveness, role, session status/expiry, Site credential generation,
manager membership, and provider access generation still apply. The receipt's
replacement generation/JTI must remain current. Sign-out, suspension, revocation,
and deletion cannot be undone by replaying a receipt. Selection or re-enrollment
that supersedes a binding's generation invalidates its receipt. Switching to
another Site keeps that Site's independent session policy; a late response
cannot overwrite the newly active local binding. Concurrent matching retries converge on the same result;
a transaction still contending after bounded reads returns retryable `409
refresh_in_progress`, preserving the client's attempt. A missing or different
attempt, expired receipt, or superseded replacement fails closed with 401.

Clients omitting the attempt ID retain legacy single-use behavior. Already-lost
sessions created before this protocol cannot be recovered retroactively.

## Validation and operations

`npm run test:sessions -w backend` starts an isolated in-memory DynamoDB Local
instance and temporary Vite server. It needs Java, the local harness's DynamoDB
Local installation, and Playwright Chromium. It uses synthetic credentials and
never reads or resets the persistent developer database.

The suite reproduces the old failure, drops a response after a real server
commit, reloads an actual browser, and verifies recovery through real IndexedDB.
It injects a local save failure and revokes between commit and reload. Additional
cases cover parallel retries, distinct attempt IDs, receipt expiry/tampering,
supersession, sign-out, independent Browser/Home Screen refresh, Site and
membership authority changes, and managed-device/provider/physical revocation.
The ordinary client suite checks retryable 0/409/503 failures, storage failure
before sending, and same-Site enrollment replacement.

After restarting the local API and frontend, enroll once through a trusted HTTPS
origin. A dev-server reload that interrupts a refresh can now retry that attempt
for up to five minutes. Do not reset generations, restore revoked rows, or bypass
revocation to recover a test session. Outages longer than the window, cleared
browser storage, missing attempt IDs, and signing-key rotation still require
re-enrollment. Real-device Quiche testing remains useful beyond the controlled
Chromium reproduction.
