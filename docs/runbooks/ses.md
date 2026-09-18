# SES sender operations

Good Neighbor's setup-code sender is `codes@goodneighborsf.org`.
SES verifies the entire domain with 2048-bit Easy DKIM in `us-west-2`,
separately in the dev account (`518892333858`) and prod account
(`701893741736`). Both accounts have production sending access.

The authoritative Route 53 zone for `goodneighborsf.org` is
`Z0308170YNRHEPQH0O3C` in prod. It holds three DKIM CNAME records for
each account. Namecheap remains the registrar; no registrar change is
needed for SES verification.

## Infrastructure ownership

Each environment's `email.tf` owns its SES identity. The prod root owns
both sets of DNS records. These resources were bootstrapped through the
AWS CLI at the user's request. Declarative import blocks adopt the existing
identities and records during the normal CI plan/apply; do not run a local
Terraform apply or create duplicate resources.

Deploy dev before prod so prod can consume the public DKIM tokens from
dev's remote-state output. Until that output exists, prod uses the public
bootstrap tokens recorded in its configuration. Replacing the dev SES
identity requires a subsequent prod deployment to update its DNS records.
Review the complete CI plan because it may include other infrastructure
changes in the environment.

## Verify sending readiness

After AWS SSO login, run for each profile (`default` for dev, `nst-prod`
for prod):

```sh
aws sesv2 get-email-identity --email-identity goodneighborsf.org \
  --profile default --region us-west-2 \
  --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status}'
aws sesv2 get-account --profile default --region us-west-2 \
  --query '{sending:SendingEnabled,production:ProductionAccessEnabled}'
```

Expected values are `verified: true`, `dkim: SUCCESS`, `sending: true`,
and `production: true`.

## Sending versus receiving

Domain verification permits SES to send from `codes@goodneighborsf.org`;
it does not create an inbox or inbound mail routing. The identity uses
SES's default MAIL FROM domain. Easy DKIM authenticates the visible
Good Neighbor sender domain.

The API Lambda sends setup-code messages through the SES v2 SDK using its
execution role. IAM limits `ses:SendEmail` to the environment's domain
identity and the exact `codes@goodneighborsf.org` From address. Terraform
sets the sender and provider app URL; dev subjects receive a `[dev]` prefix.
Messages include plain text and escaped HTML, the code, the setup link,
expiration in Pacific time, and a trusted-device reminder.

The module's optional `setup_code_email_reply_to` input configures a monitored
support address. It is unset until a support destination is chosen. Configure
feedback handling before broad rollout: email feedback currently goes to the
sender address, which has no receiving mailbox. Account suppression is enabled
for both bounces and complaints.

## Local preview and failures

The local harness (`LOCAL_API_PORT`) previews the redeemable URL in local
logs without calling SES. `SETUP_CODE_EMAIL_LOG_CODES=true` also enables
explicit local preview outside Lambda. Lambda ignores both preview flags.
Outside local preview, a missing sender or non-HTTPS app URL fails closed.

SES success logs contain the recipient hash, site name, expiry, provider message
ID, and `status: accepted`; acceptance does not prove inbox delivery. Failure
logs use `status: failed` without SDK error text, raw addresses, or setup codes.
The request endpoint retains its generic 202 response on delivery failure so
the public response does not reveal whether a contact is authorized. Its
15-minute cooldown stays in place, including after ambiguous send timeouts;
a recipient can request another code after that interval.

## Deployment verification

Run the normal CI deployment to publish the API bundle, sender configuration,
and IAM grant together. Request a code using an active site's approved code
or master contact. Confirm that the email arrives, its subject identifies dev
when applicable, and its link opens the correct environment with the code
prefilled. Unknown contacts must receive the same public response without mail.
Use the API Lambda's `setup_code_email` log marker to distinguish SES acceptance
from failure. Do not print generated codes or redemption links during production
troubleshooting.

See [AWS identity verification documentation](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
and issue #203 for delivery integration work.
