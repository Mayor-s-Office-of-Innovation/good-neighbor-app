# Site details shared by the dashboard and field app

`GET /v1/site-admin` is restricted to manager-access devices and returns the
bound Site's current metadata. Contacts are projected from shared records:

- `publicContact` is the public email, phone, and phone extension on Site `#META`.
  The field app no longer displays or edits the legacy `contactPerson` snapshot.
- `siteManagers` resolves active `MANAGER_MEMBERSHIP#` and `ASSIGNED_USER#`
  assignments to `PEOPLE / PERSON#<personId>`, deduplicating explicit person IDs.
  Older assignment links can resolve through their Program user record. Names and
  emails are read-only in the field app; phone edits use the canonical person
  transaction and update its dashboard contact projections together. Other
  contact details, affiliations, memberships, and access generations stay intact.
- `cityProgramManagers` resolves active `COMPLIANCE_MANAGER#` assignments against
  the current `ADMIN_DIRECTORY#PROGRAM_MANAGERS` directory. These contacts are
  read-only in the field app. Directory credentials and authority are not returned.

The field app refreshes this screen when opened and when returning to the app.
While a current letter is being generated, it polls with increasing delays
(3, 6, 12, 24, then 30 seconds) while visible, stopping on navigation or completion.
Temporary fetch failures retain the pending state and retry.
Open edit forms retain the user's draft instead of replacing it on focus.
The dashboard reads the same records when its Site/person view is loaded.

`PATCH /v1/site-admin` accepts `publicContact`, `siteManagerPhone`, `perimeter`,
and the existing `siteDetails` sections. `contactPerson` is retained as an older
client's alias for writing public email/phone fields. Manager phone requests
identify a person, but authority comes from a current assignment at the token's
bound Site. The write pins that assignment and the Site's active status in the
same transaction as the person revision/projection guards. Assignment removal
or concurrent profile edits produce a conflict instead of partial changes.

Perimeter edits update Site `perimeter`, `perimeterUpdatedAt`,
`perimeterUpdatedBy`, and `updatedAt`, and append the same Site audit event used
by the dashboard. The existing Site-version guard prevents concurrent writes
from silently overwriting each other. Text must be nonempty and at most 4,000
characters, matching the dashboard.

## Existing records and deployment

The people migration described in [People migration](people-migration.md) remains
required for historical records. Profiles without a canonical person link are
shown without a phone-edit control until migration, rather than creating a second
person or editing a disconnected assignment snapshot. Deploy the additive backend
before the frontend. No new table or index is required.

## Verification

- `npm test`: handler/unit and shared-person regression tests.
- `npm run test:site-details -w backend`: real handlers against isolated in-memory
  DynamoDB Local. Covers both directions of contact propagation, sanitized rosters,
  phone-only writes, perimeter persistence, authorization, and assignment-removal
  races. Requires Java and the existing local DynamoDB harness.
- `npx playwright test -c e2e/support.config.js site-details.spec.js`: synthetic
  browser fixtures for section order, contact links, edit forms, returning-focus
  refresh, narrow layout, and accessibility. Does not modify the local database.

## Canonical compliance periods and letters

The authoritative requirement history is `SITE#<siteId> / COMPLIANCE_TERMS#...`,
not the editable/legacy `#META.compliance` snapshot. The dashboard's compliance
and letter views and the field app's Site admin API project current status from
those records using Pacific calendar dates. Every period page is read consistently.
No periods means no requirement; a default cadence is not invented for reports.
The general device Site-settings response retains its existing privacy boundary
and does not expose manager-only compliance details.

Letters are current only when their `termsVersionId` matches an active canonical
period. Replaced or ended period letters appear in history; natural expiry changes
that classification immediately, even before the expiry sweep updates the stored
snapshot. Cancelled/future periods and artifacts without a matching canonical
version do not become current letters. The PDF generation worker also skips an
expired/cancelled requirement. Existing artifact metadata and files are retained;
legacy real letters without canonical versions need an explicit reviewed migration,
not fabricated compliance periods inferred from filenames.

Historical report requirements use the period applicable to each reported day.
Ending today's requirement never erases past missed-check duties or recorded
checks. Cadence changes and period boundaries remain effective-dated.

Local Site-code seeds no longer insert sample compliance snapshots or links to
`/sample-compliance-letter.pdf`. To reconcile an existing local database:

```sh
npm run local:reconcile-compliance -w backend
npm run local:reconcile-compliance -w backend -- --apply
```

The first command is a dry run. Apply uses conditional writes, removes only the
recognized unversioned sample-PDF entries, and reconciles requirement snapshots
with canonical records. It preserves real artifact metadata, canonical periods,
recorded checks, contacts, and enrollments. The command refuses non-loopback
DynamoDB endpoints and is safe to repeat. Normal restarts do not reintroduce these
fixtures. Create real testing periods through the dashboard so the normal letter
outbox, PDF generation, and history are exercised together.

The dev Site seed initializes an explicit synthetic `publicContact` with
`if_not_exists`, preserving edits on subsequent runs. It does not derive public
contact information from the legacy `contactPerson` field.

## Deliberate 311 delivery

Supervisors can use **Change 311 filing ability** under a Site's **App settings** tab,
next to **App access**. Enabled
sends user-launched requests to production 311; disabled creates simulated
requests. New/imported Sites default to enabled, and legacy Sites without the
setting are also enabled. Silent automatic notifications always use the real
integration, subject to the existing global submission kill switch.

Save changes before leaving. Concurrent Site edits return a conflict; reload the
Site before retrying. The setting is version checked and audited. It applies only
to newly accepted filings, including offline filings when they reach the backend.
Retries and existing real or simulated tickets retain their original mode.

Simulated requests display “Request filed (simulated)” in the open-ticket ticker.
On the next normal status refresh five minutes after acceptance they return Closed,
reason 1 (Resolved), using the existing closed-ticket UI. No actual City request,
attachment or note is sent. Simulated closure does not resolve the underlying
issue. Support can identify simulation from the ticket's stored delivery mode and
`SIM-` reference. Analytics exclude simulations from City-escalation counts/lists
while retaining ordinary task activity and raw provenance.
