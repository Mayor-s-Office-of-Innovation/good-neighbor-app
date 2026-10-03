# Runbook: Site Manager access recovery

## Scope

This runbook covers `POST /app/v1/manager-access/request`, its DynamoDB request controls,
Manager enrollment-email delivery, and the `ManagerAccessRateLimit` WAF rule. The route is
public and deliberately returns the same response for known, unknown, throttled, and
delivery-failed email addresses.

Never paste raw email addresses, IP addresses, enrollment URLs, tokens, or unredacted SES
message content into logs, tickets, or chat. CloudWatch records only event type, limit type,
delivery provider/status, and the number of single-Site links.

## Signals and alarms

| Alarm | Meaning | First response |
|---|---|---|
| `<env>-manager-access-throttled` | At least ten application-limit rejections in five minutes. | Check whether one limit type dominates, then compare with WAF volume. Do not loosen limits during an unexplained burst. |
| `<env>-manager-access-waf-blocked` | WAF blocked at least ten requests in five minutes. | Review WAF sampled requests for distribution and URI correctness. Keep sampled data access restricted because AWS may retain source IP metadata. |
| `<env>-manager-access-delivery-failed` | SES submission failed for at least one recovery email. | Check SES account/sender health, suppression/bounce status, Lambda permissions, and the configured sender without retrieving or replaying the enrollment URL. |
| `<env>-server-errors` | An unexpected recovery-path dependency or write failed repeatedly. | Filter for `ManagerAccessRequestFailed`, then check DynamoDB/API health and recent deployments. |

Application-log query for the API Lambda:

```text
fields @timestamp, marker, limitedBy, status, provider, siteCount
| filter marker in ["ManagerAccessThrottled", "ManagerAccessDelivery", "ManagerAccessRequestFailed", "manager_access_email"]
| sort @timestamp desc
| limit 200
```

Expected markers:

- `ManagerAccessThrottled`: `limitedBy` is `ip_hour`, `email_hour`, or
  `email_cooldown`. It does not say whether the email has a membership.
- `ManagerAccessDelivery`: records `accepted` or `failed`, provider, and link count after
  grants were created. It contains no recipient or URL.
- `manager_access_email`: SES integration metadata uses a one-way contact hash and contains
  no enrollment URL outside explicitly local preview mode.
- `ManagerAccessRequestFailed`: an unexpected internal failure; investigate the surrounding
  Lambda request and AWS service metrics.

## Abuse triage

1. Confirm the alarm environment and time window.
2. Compare application throttles with the WAF `BlockedRequests` metric for the
   `ManagerAccessRateLimit` rule.
3. If WAF blocks dominate, inspect restricted WAF samples and determine whether traffic is
   concentrated or distributed. Do not copy source addresses into general-purpose tickets.
4. If `email_hour` or `email_cooldown` dominates without a WAF burst, treat it as possible
   targeted harassment. Preserve the safe event counts and escalate through the security
   contact; do not confirm that an address is registered.
5. Keep the generic public response and minimum response-time class intact. Emergency WAF
   tightening may reduce availability for legitimate Managers and requires an incident note.
6. After the event, verify the alarm returns to OK and document only aggregate counts,
   duration, actions, and outcome.

## Delivery-failure triage

1. Confirm whether `ManagerAccessDelivery` reports `provider=ses` and `status=failed`.
2. Check SES sending status, verified sender identity, suppression/bounce/complaint events,
   account quotas, and the API Lambda's SES permission.
3. Confirm `SETUP_CODE_EMAIL_FROM` and optional reply-to configuration in the deployed
   environment. Never print the secret enrollment URL while inspecting configuration.
4. Correct the service/configuration problem. Ask the Manager to submit a new recovery
   request after the cooldown; do not reuse or manually extract an old token.
5. Confirm a later `ManagerAccessDelivery` is accepted and the alarm returns to OK.

## Safe local verification

The local API logs enrollment URLs so a developer can complete the flow without SES. This
preview behavior is disabled in Lambda. Use only synthetic local addresses and never attach
local logs containing a redeemable URL to an issue.

For deployed verification, submit a designated test Manager address, confirm the generic UI
response, redeem the single-Site link, and verify that no raw address or token appears in the
API log group. Terraform changes are planned/applied through CI, not from a laptop.
