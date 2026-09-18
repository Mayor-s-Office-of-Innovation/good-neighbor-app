# Cognito admin access

Good Neighbor's admin console uses Cognito authorization code flow with PKCE.
Account creation is administrator-only. The pool requires authenticator-app
(TOTP) MFA and passwords of at least 14 characters with uppercase, lowercase,
numbers, and symbols. Temporary invitation passwords expire after seven days.
Cognito sends invitations and recovery messages through the environment's SES
identity as `Good Neighbor <codes@goodneighborsf.org>`.

## Environment configuration

The dev pool is `us-west-2_8d60iAcSL`, in account `518892333858`, region
`us-west-2`. Its admin app client is `7d1mf2afobpkqs8uu3f3fs1375`, without a
client secret. Its login domain is
`https://good-neighbor-app-dev.auth.us-west-2.amazoncognito.com`.
The domain uses Cognito's classic hosted UI (version 1), which supports the
configured password and TOTP flow.

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

## Invite an administrator

Use the matching environment's CLI profile, region, and pool ID. First check
for an existing user. Create new users with their email address as their
username, an email attribute, and `--desired-delivery-mediums EMAIL`. Cognito
generates and emails the temporary password; do not print, store, or commit it.
Add the user to `central-admin` with `admin-add-user-to-group`. Keep user
accounts and temporary passwords out of Terraform state.

Creating a user alone does not grant admin API access: backend handlers require
membership in `central-admin`. Public self-sign-up is disabled. Do not mark an
email verified until control of that address has been established.

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

- Missing admin assets / 403 from CloudFront: check the admin S3 publication and
  the required root Terraform outputs in the deployment job.
- Callback assets fail: check that the index references `/src/` and `/config.js`.
- Token exchange blocked by CSP: check the admin-only response headers policy's
  `connect-src` Cognito origin.
- Admin API 403 after login: verify `central-admin` membership and obtain fresh
  tokens by signing out and back in.
- Invitation expired: use `admin-create-user --message-action RESEND` for that
  existing username after authorization to resend the invitation.
