# ADR 0016: Provider-wide Manager enrollment

## Status

Accepted (2026-10-13). Extends
[ADR 0015](./0015-device-bindings-and-manager-enrollment.md).

## Context

Some Provider Managers work across every Site operated by one Provider. Issuing
and redeeming a separate Site link is error-prone, while granting access from a
stale Site list could retain access after a Site changes Provider. Compliance
Managers may administer assigned Sites, but provider-wide authority crosses
those Site boundaries.

## Decision

- Only a Compliance Supervisor may create, update, deactivate, reinstate, or
  enroll a Provider Manager. A Compliance Manager has no provider-wide
  lifecycle or enrollment capability.
- A provider enrollment link is valid for 15 minutes and is single use. Its
  redemption resolves the Provider's active Sites at redemption time, not at
  issuance time.
- Redemption creates one independently selectable Site binding per active Site
  in a single DynamoDB transaction. It succeeds completely or writes nothing.
  Providers with more than 21 active Sites are rejected before issuance and at
  redemption; 21 Sites require 92 transaction operations, below DynamoDB's
  100-operation transaction limit.
- Every provider-derived binding records the Provider membership ID and
  generation. Authorization, refresh, binding discovery, and binding selection
  revalidate the membership and the Site's current Provider relationship. A
  Site that leaves the Provider therefore stops authorizing immediately.
- Deactivation advances the Provider membership generation, invalidating every
  derived binding. Reinstatement does not restore old bindings. A Supervisor
  may also revoke one provider enrollment, atomically revoking all of its Site
  binding projections.
- Enrollment and security emails identify the Provider and Site count but do
  not enumerate Site names.

## Consequences

Provider access follows current organizational ownership without copying
Provider authority into a long-lived static Site list. The fixed 21-Site limit
keeps redemption and enrollment revocation all-or-nothing. A larger Provider
will require a different design, such as generation invalidation plus durable
asynchronous reconciliation, before its links can be issued.
