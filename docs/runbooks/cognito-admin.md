# Cognito admin access

Good Neighbor's admin console uses Cognito authorization code flow with PKCE.
Account creation is administrator-only. The pool requires authenticator-app
(TOTP) MFA and passwords of at least 14 characters with uppercase, lowercase,
numbers, and symbols. Temporary invitation passwords expire after seven days.
When `enable_cognito_custom_email_sender` is true, Cognito invokes a dedicated
Lambda that decrypts its temporary password or verification code and sends the
message through the City SMTP gateway. DEV uses `goodneighbor-dev@sf.gov`; PROD
uses `goodneighbor@sf.gov`. The existing SES configuration remains declared as
the rollback path when the custom sender is disabled.

## Environment configuration

The dev pool is `us-west-2_8d60iAcSL`, in the DEV account, region
`us-west-2`. Its admin app client is `7d1mf2afobpkqs8uu3f3fs1375`, without a
client secret. Its login domain is
`https://good-neighbor-app-dev.auth.us-west-2.amazoncognito.com`.
The domain uses Cognito's classic hosted UI (version 1), which supports the
configured password and TOTP flow. The admin app client applies the small,
repository-managed customization in
`infra/modules/app/cognito-hosted-ui.css`. Cognito carries that palette across
sign-in, temporary-password, recovery, and TOTP screens. Classic Hosted UI text
and layout remain Cognito-owned; the customization intentionally has no logo
until an approved Good Neighbor asset exists.

Dev admin console: <https://ds7mtnddz2r23.cloudfront.net/>.
The registered callback is `/auth/callback` on that origin; logout returns to
`/`. The admin CloudFront policy permits connections to the exact Cognito
origin for the token exchange. Root-relative assets let the callback path load
the same app. The provider app keeps its separate security policy.

Both environment roots export the pool, client, login domain, bucket, and
CloudFront identifiers. The deploy workflow rejects missing outputs before
publishing and generates runtime `config.js` with `localDebugAdmin: false`.
The prod resources are provisioned through the standard production CI deploy;
there is no production Cognito pool until that deployment.

## My profile

The settings menu's **My profile** page lets signed-in Compliance managers and
supervisors edit their own first and last names. The profile API reads fresh
Cognito attributes and synchronizes name changes to the existing administrator
directory record. Compliance managers also see their active Site assignments.
Email and role are read-only, and the update API accepts only the two name fields.
Email changes need a separate verified-address flow and migration of the
email-keyed directory lookup; changing the email attribute alone does not change
the existing Cognito username.

## Invite an administrator

Use the matching environment's CLI profile, region, and pool ID. First check
for an existing user. Create new users with their email address as their
username, an email attribute, and `--desired-delivery-mediums EMAIL`. Cognito
generates and emails the temporary password; do not print, store, or commit it.
New administrators are normally invited from the supervisor-only
Administrators screen. Assign exactly one of `compliance-manager` or
`compliance-supervisor`. Keep user accounts and temporary passwords out of
Terraform state. `central-admin` is a temporary migration alias for
`compliance-manager`; do not add new users to it.

The admin app's Settings menu exposes User management only to Compliance
supervisors. The directory distinguishes active, invited, and suspended users.
Supervisors can resend a still-pending invitation, send password-reset
instructions to an active user, suspend either administrator role, and
reinstate a suspended user. Cognito sends both invitation and password-reset
messages; the application never generates or displays a password.

Creating a user alone does not grant admin API access: backend handlers require
one of the two Compliance groups. Public self-sign-up is disabled. Do not mark an
email verified until control of that address has been established.
The session endpoint records `email_verified=true` only after an invited
administrator has successfully authenticated with an email-address username;
password reset remains unavailable without a verified email or phone number.

The invitation identifies the Good Neighbor compliance app, includes the
environment-specific admin URL and support mailbox, and retains the seven-day
expiry. Other Cognito events use minimal code-based wording equivalent to the
current Cognito defaults.

The invited user opens the admin console, chooses Sign in, enters the exact
username and emailed temporary password, chooses a permanent password, and
sets up an authenticator app. They must complete this themselves. After the
callback, verify that providers/sites load, then sign out and sign back in.

## CLI changes and CI ownership

The initial dev pool email/invitation settings were configured with the AWS
CLI. The same settings are in `infra/modules/app/main.tf`, so CI retains them.
The existing pool, admin client, domain, and group were already Terraform
managed. A dev import block adopts the admin-only response headers policy
created during login setup. Do not run Terraform plan/apply locally.

When updating pools or clients through the CLI, preserve the current supported
settings from `describe-user-pool` or `describe-user-pool-client`: omitted
fields in update requests can reset to AWS defaults. Keep the matching
Terraform configuration in sync.

## Troubleshooting

For local user-management testing, set
`LOCAL_COGNITO_ADMIN_DIRECTORY=true` in `.env.local`. The local API then uses a
seeded, in-memory Cognito-compatible directory with active, invited, and
suspended users. Mutations reset on backend restart, and invite, re-invite, and
password-reset operations do not send email. Deployed Lambda environments must
leave this variable unset and continue to use the configured Cognito user pool.

- Missing admin assets / 403 from CloudFront: check the admin S3 publication and
  the required root Terraform outputs in the deployment job.
- Callback assets fail: check that the index references `/src/` and `/config.js`.
- `invalid_login_state` after credentials and MFA: confirm the deployed admin
  bundle includes the expiry-bound OAuth transaction fallback. The one-time
  PKCE state/verifier uses a 30-minute fallback when hosted MFA replaces the
  browser session.
  Session expiry must clear tokens only, preserving any pending login. Callback
  validation checks for a matching state in both session and fallback storage;
  stale tab state must not mask a valid fallback, and a mismatched callback must
  not consume another pending login. Run `npm run test:admin` for regressions.
- Token exchange blocked by CSP: check the admin-only response headers policy's
  `connect-src` Cognito origin.
- Admin API 403 after login: verify `central-admin` membership and obtain fresh
  tokens by signing out and back in. During migration, move the user to
`compliance-manager` or `compliance-supervisor`.

For the dev migration, first deploy the Terraform groups. Dry-run the migration
with `npm run migrate:cognito-admin-groups --workspace backend`, providing
`COGNITO_USER_POOL_ID`. Apply only after reviewing the plan, with
`ENVIRONMENT=dev`, `--apply`, and at least one
`--supervisor=<existing-username>`. The script retains `central-admin`
membership for rollback; users must sign out and back in to refresh claims.
- The app rejects self-suspension, self-demotion, and any attempt to suspend or
  demote the last enabled Compliance supervisor.
- Invitation expired: a Compliance supervisor can use Re-invite in User
  management. The backend uses Cognito's `AdminCreateUser` operation with
  `MessageAction: RESEND`; it rejects accounts that are no longer pending.

### Profile name recovery

Profile GET and PUT requests serialize by authenticated Cognito subject using an
`ADMIN_PROFILE_LOCK#<subject>` / `#LOCK` record. Before changing Cognito names for
an existing directory identity, PUT persists a recovery journal. The directory
write is the commit point. On an error, recovery consistently reads the directory
and restores Cognito to its current names, including removing attributes that
were originally absent. Recovery checks the Cognito subject before writing.

If compensation fails, the API returns `profile_recovery_pending` (503), retains
the journal, and releases the lease. The next profile GET or PUT retries recovery
before proceeding. Concurrent requests receive `profile_change_in_progress` (409).
After an invocation crashes, the lease expires after 16 minutes (longer than
Lambda's maximum execution duration); a subsequent profile request can recover.
These records intentionally do not use TTL: deleting a journal could lose repair
information. Do not delete an unresolved record as a workaround. Persistent
failures require restoring Cognito/DynamoDB availability or investigating an
identity mismatch before retrying the profile request.

Deploy the scoped `cognito-idp:AdminDeleteUserAttributes` permission with the
backend so recovery can remove originally absent name attributes. Site views
resolve oversight names by directory manager ID and retain legacy snapshots when
no directory identity can be found.

## Dashboard session lifetime

The admin Cognito client issues one-hour access/ID tokens and a seven-day
refresh token. The dashboard persists its access and refresh tokens in one
localStorage record, so login survives tab and browser closure. ID tokens are
not retained for new refreshable sessions. These credentials are accessible to
same-origin JavaScript; retain the admin CSP and XSS protections.

Before API calls (including CSV downloads), the client refreshes access tokens
within one minute of expiry. Concurrent requests in one tab share a refresh.
The session ends seven days after sign-in; refresh does not extend that deadline.
A rejected refresh token clears the session, while temporary network/server
failures preserve it for retry. Sign-out clears local credentials and attempts
Cognito refresh-token revocation even while navigating to hosted logout.
Other tabs read shared credentials on their next request; an in-flight refresh
cannot restore a signed-out session.

Deploy both the admin bundle and Terraform client settings through CI. Existing
tab-only sessions need one new sign-in to receive persistent credentials. When
persistent storage is blocked, credentials fall back to tab storage and cannot
survive closing that tab. No Terraform apply is performed locally.
