# SES sender operations

Good Neighbor's setup-code sender is `codes@goodneighborsf.org`.
Both application environments now deploy in AWS account `518892333858` and use
the same verified SES domain identity in `us-west-2`, with 2048-bit Easy DKIM.
The identity was verified with DKIM status `SUCCESS`, sending enabled, and
production SES access on 2026-09-23. Production is configured with separate
application resources, deploy credentials, and Terraform state.

The authoritative Route 53 zone for `goodneighborsf.org` is
`Z0308170YNRHEPQH0O3C` outside the application production Terraform root.
It holds the DKIM CNAME records needed for the sender. Namecheap remains the
registrar; no registrar change is needed for SES verification.

## Infrastructure ownership

The dev Terraform root owns the shared SES identity and exports its ARN. The
production root reads that ARN from the dev remote state and grants its API
Lambda permission to send from the identity. Production does not import or
manage the SES identity or the parent-zone DKIM records. Keep the dev state and
identity in place before deploying production; replacing that identity requires
coordinated DNS and production IAM updates. Do not run a local Terraform apply
or create a duplicate identity.

## Verify sending readiness

After AWS login to account `518892333858`, run:

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
