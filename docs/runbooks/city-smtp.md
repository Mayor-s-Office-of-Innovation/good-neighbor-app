# City SMTP relay operations

Good Neighbor sends City application email through an authenticated SES Mail
Manager ingress point, which relays it to Proofpoint Secure Email Relay over
STARTTLS. DEV uses `goodneighbor-dev@sf.gov`; PROD will use
`goodneighbor@sf.gov`. DT has approved both senders, internal and external
recipients, shared credentials across the two AWS accounts, and confirmed that
no source-IP allowlist or application-side DNS changes are required.

The existing direct-SES senders remain active until the dev relay is proven.
Do not switch Cognito or Manager enrollment as part of this bootstrap.

## Bootstrap dev

The bootstrap deliberately takes two CI deployments so secret values never
enter Terraform state.

1. Deploy with `enable_city_smtp_relay = false` in
   `infra/environments/dev/main.tf`. This creates two empty secret containers.
2. Read their ARNs:

   ```sh
   terraform -chdir=infra/environments/dev output -raw city_smtp_relay_secret_arn
   terraform -chdir=infra/environments/dev output -raw mail_manager_ingress_secret_arn
   ```

3. Put the Proofpoint value into the first secret from a trusted shell. Avoid a
   literal password in shell history by preparing a protected temporary JSON
   file using the operator's approved password-manager workflow:

   ```sh
   aws secretsmanager put-secret-value \
     --secret-id <city_smtp_relay_secret_arn> \
     --secret-string file://<protected-proofpoint-json> \
     --region us-west-2
   ```

   The file must contain `username` and `password` string properties. Delete it
   securely according to the workstation's credential-handling policy.

4. Generate a separate ingress password and put `{"password":"..."}` into the
   second secret. This is not the Proofpoint password. Keep the generated value
   in the approved password manager because SMTP clients will need it.
5. Change `enable_city_smtp_relay` to `true`, review the complete CI plan, and
   deploy again. Terraform creates the Mail Manager gateway through its owned
   CloudFormation stack.

The deployment role needs CloudFormation and SES Mail Manager CRUD permissions,
CloudWatch Logs v2 delivery permissions, and
`ses:AllowVendedLogDeliveryForResource`. A denied stack event identifies a
missing deployment-role permission; do not work around it with console-created
resources.

## Connectivity test

Wait until the requested dev mailbox exists. Obtain the non-secret endpoint
values from Terraform and the ingress password from the approved password
manager. The probe always uses `goodneighbor-dev@sf.gov` and refuses a different
From address.

```sh
SMTP_HOST="$(terraform -chdir=infra/environments/dev output -raw mail_manager_ingress_hostname)" \
SMTP_USERNAME="$(terraform -chdir=infra/environments/dev output -raw mail_manager_ingress_username)" \
SMTP_PASSWORD='<ingress password>' \
SMTP_TO='<designated test recipient>' \
npm run test:mail-relay -w @good-neighbor/backend
```

Test one City recipient and one external recipient. Confirm STARTTLS, receipt,
the dev From address and subject marker, and SPF/DKIM/DMARC results. Then send an
intentionally invalid recipient and confirm the notification reaches the dev
mailbox or is visible to the DT mail team.

Mail Manager logs are written to
`/aws/ses/mail-manager/good-neighbor-app-dev`. Relay failures alarm through the
environment alarm SNS topic. SES acceptance proves only that the next SMTP hop
accepted a message, not inbox delivery.

## Rotation and incidents

DT says Proofpoint credentials do not normally expire. DT provides 30 days for
a routine rotation, but may require immediate replacement during a security
incident. Put the new value as a new `AWSCURRENT` secret version. Mail Manager
can continue accepting `AWSPREVIOUS` during coordinated ingress-password
rotation; remove the old version after every client has changed.

On failure, check in order: CloudFormation stack status, Mail Manager rule-set
logs, the relay-failure alarm, sender authorization, mailbox notices, and the DT
mail team. Never paste SMTP credentials, message bodies, authentication codes,
or full recipient addresses into tickets or logs.
