# ADR 0015: Compliance administrator roles

- Status: Accepted
- Date: 2026-10-08

## Decision

The admin application has two Cognito-backed roles: `compliance-manager` and
`compliance-supervisor`. The legacy `central-admin` group is accepted only as a
temporary alias for Compliance manager during migration.

Updated 2026-10-23: Compliance managers may read Sites, but may change Site
details, oversight, compliance, and app access only when their active directory
identity has an active assignment to that Site. This includes adding/removing
Site managers and creating a manager in the Site's lead Program. Other Sites
are read-only. Shared staff changes and cross-Site device revocations require
authorization for every affected Site before any mutation.

They may not create or deactivate providers, programs, or Sites; change a
Site's lead Program; assign Compliance managers; change shared City manager
records; run imports; or administer Cognito users. Those remain supervisor-only.

Compliance supervisors have those additional capabilities. They may invite,
suspend, reinstate, and change the role of either administrator type. The
system prevents self-suspension, self-demotion, and suspension or demotion of
the last enabled supervisor.

Authorization is enforced by Lambda handlers. UI capability checks exist for
clarity but are not a security boundary.

Site managers and Site users remain device-bound domain identities, not
Cognito users. The legacy `admin` device access value is read as `manager`; new
grants use only `manager` or `general`.

Legacy master contacts are migrated to Site manager memberships in dev. Code
contacts are not migrated, and neither legacy contact type remains an
authorization source for setup codes.

## Consequences

Administrator role changes take effect after token renewal. Cognito lifecycle
operations require additional narrowly scoped permissions on the API Lambda.
Data migration is dry-run by default and requires an explicit dev-only apply.
