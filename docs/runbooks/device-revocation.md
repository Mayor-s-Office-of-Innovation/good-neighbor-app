# Runbook: device revocation

## Scope

This runbook covers City individual-binding, selected-binding, and Site-wide revocation.
All operations preserve history. Re-enrollment creates a new binding; it never reactivates a
revoked binding or lowers a credential generation.

## Expected behavior

- Individual revocation atomically marks the canonical binding, compatibility Device row,
  and physical-device pointer revoked and increments the binding generation.
- Selected revocation performs those changes for up to 20 canonical bindings in one
  transaction. Either the complete selection changes or none does.
- Site-wide revocation first advances `siteCredentialGeneration` transactionally. Current
  canonical credentials then fail authorization even while display rows are being reconciled.
- Unmigrated legacy dev devices do not understand the Site generation, so the same request
  explicitly revokes their Device rows. A partial legacy reconciliation requires immediate
  follow-up.

Every successful request returns an operation ID. Site-wide operations retain counts and end
in `complete` or `partial` state under the Site partition.

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

## Conflict response

A `409 device_revocation_conflict` means a binding changed after it was read. Reload the Site
before retrying. Never overwrite the newer state or manually reduce a generation. A missing
binding in a selected operation returns `404` and changes none of the selection.

## Re-enrollment

A revoked or suspended Site binding is immutable. If an authorized Site Manager or City
administrator issues a new valid enrollment link, redemption creates a new binding with the
current Site and membership generations. Existing revoked rows remain visible for audit.
