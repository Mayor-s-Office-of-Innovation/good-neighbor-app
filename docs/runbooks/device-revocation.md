# Runbook: device revocation

## Scope

This runbook covers City individual-binding, selected-binding, Site-wide, and
physical-device-wide, emergency multi-Site revocation, and Provider Manager
enrollment revocation.
All operations preserve history. Re-enrollment creates a new binding; it never reactivates a
revoked binding or lowers a credential generation.

## Expected behavior

- Individual revocation atomically marks the canonical binding, compatibility Device row,
  and physical-device pointer revoked and increments the binding generation.
- Selected revocation performs those changes for up to 20 canonical bindings in one
  transaction. Either the complete selection changes or none does.
- Site-wide revocation first advances `siteCredentialGeneration` transactionally. Current
  canonical credentials then fail authorization even while display rows are being reconciled.
- Physical-device-wide revocation previews every affected Site, requires the exact device
  label as typed confirmation, and changes the physical record plus up to 20 active Site
  bindings in one transaction. It writes an audit event to every affected Site.
- Emergency multi-Site revocation previews every current binding for 2–20 selected Sites and
  requires the generated phrase. One transaction advances every selected Site generation
  before one asynchronous reconciliation job is queued per Site.
- Provider Manager enrollment revocation is Supervisor-only and atomically revokes the
  canonical binding, compatibility Device row, and physical pointer for every Site in that
  enrollment (maximum 21). Deactivating the Provider Manager instead advances the membership
  generation, immediately denying every derived binding; reinstatement does not reactivate
  those older bindings.
- Unmigrated legacy dev devices do not understand the Site generation, so the same request
  explicitly revokes their Device rows. A partial legacy reconciliation requires immediate
  follow-up.

Every successful request returns an operation ID. Site-wide operations retain counts under
the Site partition. Emergency multi-Site operations also retain an aggregate operation and
one idempotent Site-result row, ending in `complete` or `partial` state.

## Partial-operation alarm

`<env>-revocation-operation-partial` fires on `RevocationOperationPartial`. Query the API
Lambda logs without copying device IDs into general-purpose tickets:

```text
fields @timestamp, marker, operationId, siteId, failedCount
| filter marker = "RevocationOperationPartial"
| sort @timestamp desc
```

1. Open the affected Site's App access view and confirm the operation ID and current rows.
2. Confirm the Site's credential generation advanced. If it did, canonical credentials are
   invalid even if a row still appears active.
3. Identify whether remaining active rows are canonical or legacy. Do not decrement or roll
   back the Site generation.
4. Retry individual revocation for each unreconciled row. For a legacy row, verify its
   `tokenGeneration` increased and status is `revoked`.
5. Test a previously active device: refresh and protected API access must fail. Do not use a
   production credential in logs or screenshots.
6. Record aggregate outcomes and the operation ID, then confirm the alarm returns to OK.

For an emergency multi-Site operation, first inspect
`REVOCATION_OPERATION#<operationId> / #META`. An `enqueueFailedCount` means the affected Site
generation still advanced, but its display-row reconciliation was not queued. Use the Site
operation record to identify the Site, reconcile its remaining active rows, and never reduce
the Site generation. A partial Site-result row identifies a job that ran but could not update
every projection.

## Conflict response

A `409 device_revocation_conflict` means a binding changed after it was read. Reload the Site
before retrying. Never overwrite the newer state or manually reduce a generation. A missing
binding in a selected operation returns `404` and changes none of the selection.

## Re-enrollment

A revoked or suspended Site binding is immutable. If an authorized Site Manager or City
administrator issues a new valid enrollment link, redemption creates a new binding with the
current Site and membership generations. Existing revoked rows remain visible for audit. A
physical-device-wide revocation also blocks that physical identity from redeeming a new
grant; enrolling again requires a newly established physical-device identity.

For a suspended general binding, the Site Manager issues a new staff grant. For a suspended
Manager binding, a City administrator issues a new Manager grant for the still-active Site
membership. Do not edit the suspended row back to `active`, reduce its token generation, or
reuse its refresh family. Confirm the new binding is active and the old binding remains
suspended with its original reason and timestamp.

## Home Screen handoff grants

A device running in iOS Safari keeps one pending `SESSION_HANDOFF#` grant
(`handoffGrantId` on its `DEVICE#` row) so an Add to Home Screen carries the
session into the installed app. Redemption re-checks the device, its binding,
the Site generation, and Manager membership exactly like the authorizer, so
every revocation above also kills any pending grant; nothing extra is needed.
The grant travels in a Secure, HttpOnly, SameSite=Strict installation cookie;
the manifest fragment remains a compatibility fallback. An explicit sign-out
in Safari retires the grant (`session_handoff_retired` audit event), clears
the cookie, and puts the static manifest back on the page.
Redemption adds a Home Screen session to the same managed device and writes a
`session_handed_off` audit event with `deviceId` and `sessionId`. Safari's
credentials remain valid. The manager sees one device with Browser and Home
Screen app sessions underneath. Revoking that device disables both, including
refresh and pending installation grants; no second device entry is required.
Signing out ends only the current session. Absolute expiry and authority
checks still apply to every session. Never implement whole-device revocation by
changing only the primary session's token generation: use the managed revocation
endpoints, which change parent status or authority generations.
See [ADR 0019](../adr/0019-home-screen-session-continuity.md).

## Interrupted refresh recovery

A browser can recover a lost refresh response for five minutes using its saved
attempt ID and original signed refresh token. Recovery rechecks current authority
with strongly consistent reads and only returns a still-current replacement pair.
All revocation controls above invalidate pending recovery receipts as well as
ordinary refresh. Explicit sign-out increments the current session generation
atomically, so a refresh committed between the sign-out read and write cannot
leave the session active. Transient transaction conflicts retry within a bounded
window; persistent conflicts return 409 instead of reporting success.

Sign-out also checks and transactionally pins `sessionStartGeneration`, the
stable generation floor of the enrollment/session. Refresh preserves this floor;
re-registration and reactivation advance it. A cached token from an older
enrollment therefore cannot end its replacement, even when replacement happens
between the sign-out read and write. Legacy sessions without a floor retain
compatibility until their next registration/reactivation; the transaction pins
the field's absence. Registration itself uses a generation compare-and-swap and
returns 409 if another registration or refresh wins first.

Site selection rechecks the source session and current authority with strong
reads, and pins the source session in the selection transaction. Cached gateway
authorization cannot use a signed-out or revoked source to mint another Site's
credentials. The browser also binds refresh promises and retries to the original
local enrollment, including when a new enrollment uses the same Site.
 Do not restore status or reduce generations to recover access.
Receipts remain encrypted and bounded to one per session; their expiry is enforced
by the handler even if the encrypted data remains in DynamoDB. See
[ADR 0020](../adr/0020-retryable-refresh-recovery.md) for the protocol and tests.

## Compliance dashboard controls

Site details contains Site Manager assignments and the add/edit/remove controls.
App access contains direct magic-link and one-time-code email actions, enrollment
history with its delivery type, and enrolled-device nicknames and attribution.
Manager devices show their membership email. Team devices show the issuing
manager's email resolved through the staff grant. Older records without a known
association show “Email unavailable”; a nickname alone is not proof of ownership.

The red trash icon revokes only that row's Site access, with confirmation.
The Site-wide revocation control still affects every device at that Site.

On Manager details, below Assigned sites, “Remove access to all sites” requires
the manager's email as confirmation. Its endpoint is
`POST /admin/v1/programs/{programId}/users/{userId}/devices:revoke`.
It discovers memberships using the email directory, Program Sites, and active
Site directory (including retained memberships after a lead Program change),
revalidates their Program/user identity, and revokes the manager's own Site bindings. It does not remove assignments, deactivate memberships, revoke
team devices, or disable the physical device identity. A new valid enrollment
can therefore restore app access. Pending invitations are not cancelled.

Revocation uses atomic batches of at most 20 bindings, updating canonical,
compatibility, and physical-device pointer records together with a Program audit
event. A failure returns `409 manager_device_revocation_incomplete` and the count
confirmed so far; retry discovers remaining non-revoked bindings. A timeout can
leave the latest batch's outcome uncertain, so the UI never claims full success
on a failed request. Batches already completed remain revoked.
