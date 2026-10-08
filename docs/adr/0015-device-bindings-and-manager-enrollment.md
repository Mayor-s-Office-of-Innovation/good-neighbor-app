# ADR 0015: Physical devices, Site bindings, and email-based Manager enrollment

## Status

Accepted (2026-10-03). Supersedes the lifetime and role portions of
[ADR 0010](./0010-device-token-auth.md); its signed-token and live-revocation
mechanism remains in use.

## Context

A browser can serve more than one Site, while authorization and revocation are
Site-specific. Site Managers must not receive Cognito identities. Enrollment
links must be single-use, short-lived, and restricted to one Site. Existing
development devices and tokens use the role name `admin` and a combined
Site/device record, so deployment needs a bounded compatibility path.

## Decision

- Store a stable physical-device identity separately from each Site binding.
- Store Manager membership by normalized email at one Site; membership removal
  advances its generation and invalidates bindings derived from the old value.
- City administrators issue a 15-minute, single-use Manager enrollment link.
  Only a SHA-256 verifier is stored. Redemption atomically consumes the grant,
  rechecks membership, and creates the binding.
- New records and tokens use `manager`; readers treat legacy `admin` as
  Manager-equivalent and refresh migrates it to `manager`.
- Access tokens last 15 minutes. Rotating refresh tokens last 30 days. An
  enrollment has a 365-day absolute lifetime and a 60-day inactivity limit.
- Authorization rechecks binding status, token generation, Site generation,
  and Manager-membership generation. The request body never chooses its Site.
- Keep a `DEVICE#` compatibility projection during migration so existing
  authorizer and field API keys remain stable. Remove it only after all clients
  and operational tools use `DEVICE_BINDING#` directly.

## Consequences

One physical browser can safely accumulate independently revocable Site
bindings. Removing Manager membership or advancing a Site generation cuts off
new requests without a Cognito operation. Link possession remains a sensitive
short-lived credential, so fragments are removed from browser URLs before
network or persistence work and are never logged. Compatibility code must be
removed after old `admin` sessions and combined device records have expired or
been migrated.
