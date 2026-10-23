# ADR 0017: People, affiliations, and access assignments

## Status

Accepted (2026-10-23). Extends the program staff and provider manager model.

## Decision

A person has a stable `personId` and one contact profile, stored at
`PEOPLE / PERSON#<personId>`. Optional `primaryProviderId` and `primaryProgramId`
are descriptive affiliations. Neither grants access nor restricts site assignments.
The site's lead provider and lead program are selected independently.

Site manager memberships and provider manager memberships remain the authorities
for device access. Existing membership IDs, generations, grants, and bindings are
not rewritten by the person migration. Existing program staff keys remain as
compatibility references; changing a primary affiliation does not relocate them.
New direct site manager assignments can reference `personId` without program staff.

A person stores references to its contact projections. Profile edits update the
canonical person and those projections in one conditional transaction, including
email recovery directory pointers. The person's revision serializes assignment
registration and contact changes. Updates exceeding DynamoDB's 100-operation
transaction limit fail without partial writes; they require a separate larger-scale
reconciliation design. Missing historical projections are skipped; mismatched person
identities fail closed. Membership and device generations are unchanged by edits.

Only supervisors change affiliations, transfer provider managers, or reassign a
site's lead provider/program. Assigned compliance managers retain site-scoped manager
assignment capabilities; shared contact changes must satisfy the applicable scope
checks. Creating or changing an affiliation never creates a device binding.

Provider transfers atomically end the old provider assignment, advance its generation,
and create a new assignment for the same person. Existing invitations and devices
cannot authorize under the new membership. Direct site assignments are retained.
A site provider change advances `providerAccessGeneration`, checked by provider-derived
authorization, refresh, and device discovery. Returning a site to its former provider
cannot revive an old device. Direct site bindings do not check this provider-only
version. Changing only the program leaves both device authorities unchanged.

## Migration and compatibility

Run `backend/scripts/migrate-people.mjs` first in dry-run mode, then with `--apply`
against the intended environment after reviewing the counts/conflicts. Each person
and its existing source references are linked atomically. Repeated runs skip linked
records. Existing contacts remain separate even when names and email addresses match;
there is no automatic merge. Selecting an existing person for another role explicitly
reuses that identity. Combining two already-existing person records is not automatic.
Historical letters, report records, audits, and contact snapshots are not rewritten.

The migration follows explicit `staffSource` chains and reuses already-linked people
with revision protection. Missing sources, cycles, conflicting person identities,
and groups exceeding the transaction limit are reported without partial writes.
Conditional-write conflicts are reported per group while later groups continue;
unexpected failures abort the run. A report containing unresolved conflicts exits
with a nonzero status. Review and resolve those conflicts before rerunning.

Deploy the additive APIs before the frontend. The migration is required before
transferring older provider manager records. Legacy manager URLs continue resolving
through their source references. No new table or index is required.

Provider-wide device revocation retains provider assignments. Removing an individual
provider manager ends that assignment and retains the person record. Site manager
assignment removal affects only that site.
