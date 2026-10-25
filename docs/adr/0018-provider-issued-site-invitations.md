# ADR 0018: Provider-issued site invitations

## Status

Accepted (2026-10-24). Extends ADRs 0015, 0016, and 0017.

## Decision

An active Provider Manager may invite either a Site Manager or a Site Team Member
from Manage access, scoped solely to the currently selected Site. The form starts
with neither role selected and requires an explicit radio choice. Site Manager
invitations additionally require first name, last name, and email address. Site Managers retain
their existing ability to invite team members; they cannot delegate manager access.

Creating a Site Manager invitation atomically creates an independent named person,
Site Manager membership, person/email directory projections, audit events, and the
single-use invitation. Existing Site Managers are retained, and the existing primary
contact selection rule is preserved. An existing email assignment conflicts rather
than silently replacing or merging another person's identity. Cancellation or expiry
of an invitation does not remove its named assignment; assignment removal and device
revocation remain the existing administrative operations.

Both invitation types use the existing eight-hour, single-use `STAFF_GRANT#` flow,
including rate limits, sharing, QR codes, and cancellation. A manager invitation
contains the target `membershipId` and generation; its resulting device is a direct
Site Manager binding, never a Provider Manager binding. The new person is recoverable
through the ordinary manager email directory. The invitation itself is shared by its
issuer through the existing sharing controls.

Provider-issued grants record the issuer's Provider, membership ID and generation,
Site credential generation, and Site provider-access generation. Creation and
redemption conditionally recheck the issuing binding, membership, and Site ownership
in the same transaction as their writes. Older malformed provider-issued team grants
without authority snapshots remain invalid; issue a fresh invitation after deployment.

## Consequences

Provider Managers can delegate management of their own Sites without replacing
existing managers or gaining central administration rights. A successful direct
Site Manager assignment remains independent of later Provider changes, as in ADR 0017.
The field UI's capability flag is advisory; the backend enforces every role and scope.
