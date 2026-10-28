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
| `<env>-manager-security-notification-failed` | A Manager device was enrolled, but its post-enrollment security notification failed. | Treat the binding as valid, restore delivery, and use Site Admin delivery evidence to identify the affected grant without exposing its recipient or token. |
| `<env>-server-errors` | An unexpected recovery-path dependency or write failed repeatedly. | Filter for `ManagerAccessRequestFailed`, then check DynamoDB/API health and recent deployments. |

Application-log query for the API Lambda:

```text
fields @timestamp, marker, limitedBy, status, provider, siteCount, siteId
| filter marker in ["ManagerAccessThrottled", "ManagerAccessDelivery", "ManagerAccessRequestFailed", "ManagerSecurityNotification", "ManagerSecurityNotificationEvidenceFailed", "manager_access_email", "manager_security_notification_email"]
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
- `ManagerSecurityNotification`: accepted/failed result after a Manager binding is created.
  Failure never rolls back the valid binding. The redeemed grant retains provider, message
  ID, status, and update time for authorized Site Admin review.
- `ManagerSecurityNotificationEvidenceFailed`: delivery was attempted, but its evidence
  could not be attached to the redeemed grant; inspect DynamoDB health and permissions.

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

## Post-enrollment notification failure

1. Confirm the Manager binding was successfully created; never revoke it solely because the
   notification failed.
2. Locate the redeemed grant through the authorized Site Admin view and inspect its
   `securityNotificationStatus`, provider, message ID, and update time.
3. Follow the SES checks above. If evidence persistence failed, separately inspect DynamoDB
   health and the API Lambda's update permission.
4. If enrollment looks suspicious for other reasons, contact the Manager through an approved
   channel and use normal device revocation. Delivery failure alone is not compromise proof.
5. After repair, verify notifications with a designated test Manager enrollment. Do not
   resend an old enrollment credential.

## Safe local verification

The local API logs enrollment URLs so a developer can complete the flow without SES. This
preview behavior is disabled in Lambda. Use only synthetic local addresses and never attach
local logs containing a redeemable URL to an issue.

For deployed verification, submit a designated test Manager address, confirm the generic UI
response, redeem the single-Site link, and verify that no raw address or token appears in the
API log group. Terraform changes are planned/applied through CI, not from a laptop.

## Invitation confirmation and manual enrollment codes

Provider and Site Manager invitations expire after 24 hours and remain single use.
Opening an enrollment link shows a confirmation screen; only submitting **Enroll
this device** redeems it. Staff and recovery links use the same confirmation screen.

In the Provider manager row and the Site's App access manager row, **More options**
(to the right of Edit) → **Email code** issues a fresh invitation in manual mode.
The email includes a six-character uppercase letter/digit code and a plain `#login=1` link that opens the
existing six-character login screen, including on a previously enrolled device.
The code is entered in the normal code field and submitted with Continue.
It redeems the same scoped manager grant; no separate enrollment-code screen is used.
Codes are single use and stored only as verifiers. The plain link contains no code.

Provider issuance still rejects a second unexpired invitation until it is cancelled
or expires. Site Manager issuance retains its existing replacement behavior.
Choosing Email code does not revoke previously enrolled devices.

### Troubleshooting consumed invitations

A successful redemption proves a client received credentials, not that the named
recipient personally used the app. Email-security browsers may execute JavaScript.
Confirmation reduces accidental scanning redemptions; use manual codes when a
scanner also interacts with confirmation controls.

API responses distinguish verified used (409), expired/cancelled (410), changed
access (403), and transaction conflict (409) invitations. Unknown credentials
remain a generic 401. The UI displays a support reference when available.
Old grants whose token lookup was deleted before this change remain generic
invalid-invitation errors; no historical secrets or lookups are reconstructed.

CloudWatch markers `EnrollmentRejected` and `EnrollmentRedeemed` include the API
request ID and, once verified, grant ID. Rejections include a reason and DynamoDB
cancellation codes when available. Successful events include scope, delivery mode,
physical-device ID, and a coarse browser/device description. Never log the request
body, raw token/code, or complete invitation URL. Correlate request IDs with API
Gateway access logs when investigating scanner activity.

If scanner consumption is suspected, review/revoke the affected enrollment before
issuing a replacement. A replacement invitation does not invalidate its predecessor's
already-created sessions. The deployed frontend must include the confirmation
change before scanning tests are meaningful.

### Short-code abuse controls

`/site-code`, manual-code submissions to `/app/v1/enrollment/redeem`, and setup-code
registration at `/v1/devices` consume the same atomic DynamoDB budget before any credential lookup: 1,000 attempts
per five-minute UTC window and 10,000 per UTC day, per environment. Successful
lookups, redemptions and registrations count too (a normal lookup plus enrollment or
registration consumes two attempts). Token refresh and long-token redemption do not spend
this application budget. Malformed inputs are rejected before credential resolution.
The counters have numeric TTLs; window keys, not TTL deletion timing, control resets.
This global cap also covers distributed guesses and requests sent directly to API Gateway.
No counter is tied to an invitation or to a caller-supplied IP header.

CloudFront WAF additionally shares a 300-request/five-minute viewer-IP limit across
`/site-code` and `/app/v1/enrollment/redeem`. This edge rule includes link redemption,
while the application budget applies only to short codes. Setup-code registration
uses the separate device-auth WAF rule. Infrastructure changes deploy through CI.

Exhausted application budgets return 429 with `Retry-After`, a localized wait message,
and a `ShortCodeThrottled` log event without credentials. During an attack, the global
cap can temporarily prevent all code logins until the window resets; full-token
invitations remain outside that application cap. Investigate sustained throttling
before raising limits. Storage failures fail closed before code resolution.
`ShortCodeAttempt` records only a fixed route label (`lookup`, `redeem`, `register`) and
budget outcome (`admitted`, `store_error`). Admission is not successful authentication.
`ShortCodeThrottled` includes the route label and retry delay. No credentials or caller-supplied
IP headers are logged by these events.

The windows are fixed: traffic can consume allowances immediately before and after a
boundary. Manual short-code enrollment uses two requests through the enrollment WAF
rule: the edge allowance permits roughly 150 enrollments per shared IP per five minutes.
Setup-code login uses one lookup under that rule and one registration under the separate
device-auth rule. Both flows consume two application attempts, allowing roughly 500 logins
across the environment per five-minute window, before retries or invalid attempts. Raising the global budget increases the
permitted guessing allowance; it does not preserve the previous numerical allowance.


## Invitations created in Manage access

Deploy the additive backend changes before the frontend.

Provider Managers must choose Site Manager or Site Team Member under the device
nickname. Site Manager invitations require first name, last name, and email and create an additional
named assignment on the selected Site. Site Managers see their existing team-only
form. Both shared links expire after eight hours; no email is sent automatically.
Cancelling a link or letting it expire does not remove a named manager assignment.

A Provider Manager's invitation is rejected if the issuing binding, Provider
membership, Site ownership, or access generations changed before redemption.
Older provider-issued team invitations lacking authority snapshots cannot be repaired
by retrying them; create and share a fresh invitation after the fix is deployed.
A duplicate manager email assignment is a conflict, never a replacement. Use the
existing named assignment's administrative enrollment/recovery flow in that case.

Team Devices lists both Site Managers and Site Team Members. Provider Managers can revoke either site role’s device; Site Managers can revoke only Site Team Member devices. Provider Manager device authority is managed separately. Device revocation invalidates that binding and its tokens without removing the person’s named manager assignment or other devices. Manager-device revocation validates the acting Provider Manager’s current membership and site authority in the same transaction as revocation.

Manage access refreshes capabilities while visible, including after returning to the page and when no enrollment links remain. Losing authority disables protected actions without clearing the invitation draft or changing its selected role. A duplicate manager email returns a specific conflict message without retrying; only issuance-guard contention and transaction conflicts receive bounded retries.
