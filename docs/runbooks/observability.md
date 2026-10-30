# Runbook: observability (alarms, business metrics, uptime)

**Scope:** what pages, what the business metrics mean, and where to look first. CloudWatch is the
operational source of truth ([ADR 0008](../adr/0008-lean-client-error-capture.md));
PostHog carries client errors, page/camera events and feedback only
([client-events.md](./client-events.md), [feedback-ops.md](./feedback-ops.md)); the
analytics lake ([ADR 0013](../adr/0013-analytics-read-plane.md)) serves stakeholder
reporting and trails live data by about 6 hours.

## Who gets paged

Both SNS topics subscribe the same `alarm_emails` list, set per environment in
`infra/environments/<env>/variables.tf` and passed through `main.tf`. Every address gets one confirmation email **per
topic** (two in total) and is silent until confirmed.

| Topic                                      | Region    | Why it exists                                                                              |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------ |
| `good-neighbor-app-<env>-alarms`           | us-west-2 | every code-marker alarm (`alarms.tf`) and every platform alarm (`platform-alarms.tf`)      |
| `good-neighbor-app-<env>-alarms-us-east-1` | us-east-1 | metrics that only exist there: the Route53 uptime check and the CloudFront-scoped WAF rule |

Production response ownership is:

| Responsibility                                      | Responder                |
| --------------------------------------------------- | ------------------------ |
| Primary: acknowledge, diagnose, coordinate recovery | `aaron.hans@sf.gov`      |
| Secondary: cover the primary and assist recovery    | `beaudry.kock@sfgov.org` |

SNS emails both people simultaneously. It does not wait for the primary, track
acknowledgment, or escalate automatically. Record the incident owner and
acknowledgment in the incident issue; do not treat this as a staffed 24-hour
paging service without agreed coverage and response times. DEV retains its own
recipient configuration.

## Confirming production subscriptions and testing delivery

Deploy the production configuration through reviewed CI first. The expected plan
adds the secondary's two subscriptions and two isolated `TEST-alarm-delivery`
alarms, and changes the daily budget limit and ACTUAL threshold to USD 50.
Existing service alarms remain active. Both responders must confirm **both** SNS
subscriptions from their email. `PendingConfirmation` is not a working delivery
route. If a confirmation email is missing/expired, request another confirmation
through SNS for that same endpoint; do not invent confirmation tokens or
unsubscribe a working recipient. Reinspect AWS afterward.

From the repository root, with the approved production AWS login and the verified
account ID in `AWS_ACCOUNT_ID`, inspect without sending:

```sh
node scripts/test-alarm-delivery.mjs --account-id "$AWS_ACCOUNT_ID"
```

The script checks the AWS identity, both regional subscription inventories, and
the exact synthetic alarm configuration. It refuses mutations if either
responder is unconfirmed on either topic. The read-only output can be attached
to the incident/cutover issue; it contains no tokens or message bodies.

Arrange a test window with both responders, wait until both test alarms are OK,
then exercise CloudWatch → encrypted SNS → inbox:

```sh
node scripts/test-alarm-delivery.mjs --account-id "$AWS_ACCOUNT_ID" --send
```

Only the dimensionless `AlarmDeliveryTest` metric in the
`good-neighbor-app-prod-operations` namespace is published, once per region.
The test alarm names include `TEST`; no service alarm is forced into ALARM and
no queue message or application data is created. Each alarm evaluates at a
one-minute period. Allow several minutes for evaluation and delivery. An AWS
publish success or an alarm transition does **not** prove an email arrived.

Record the drill ID, start time, each region's ALARM transition, and the email
receipt/acknowledgment time from each responder (four acknowledgments total).
If a region fails to publish after the other succeeds, inspect both before
retrying; delivery is not an atomic cross-region operation.

After seeing the ALARM notification, reset the synthetic metrics:

```sh
node scripts/test-alarm-delivery.mjs --account-id "$AWS_ACCOUNT_ID" --reset
```

Wait for both test alarms to return to OK and confirm the recovery emails. The
Maximum statistic means a reset in the same minute as the trigger does not erase
the earlier breach. Missing data is non-breaching, so a one-off test also clears
naturally. The two small test alarms remain managed by Terraform for future
drills; do not delete them manually. The script reports `receiptVerified: false`
because only recipients can provide delivery evidence.

If a notification is missing, inspect confirmation status, spam/quarantine,
CloudWatch alarm history/action errors, the topic policy, and the regional KMS
key's CloudWatch-service permissions. An unconfirmed subscription cannot be
fixed by repeatedly sending test metrics.

## The dashboard (`infra/modules/app/dashboard.tf`)

CloudWatch → Dashboards → `good-neighbor-app-<env>-ops`, opening on the last 24 hours. Rows, top to
bottom: alarm status for every home-region alarm · activity (checks started vs completed,
completed perimeter checks by evidence, analyses by kind) · analyzer (latency p50/p95,
failed/retried/duplicate, failure rate) · pipeline (queue depth, in flight, dead-lettered,
oldest-message age; worker invocations, errors, throttles, concurrency, duration) · API
Gateway and request-path Lambdas · uptime from Route53, the code-reported fault metrics,
and CloudFront WAF allowed vs blocked. Alarm thresholds are drawn as red/orange lines on
the widgets they guard. The two us-east-1 alarms (uptime, WAF rate limit) are not in the
alarm-status widget, which is same-region only; their metrics are the bottom row.

## Platform alarms (`infra/modules/app/platform-alarms.tf`)

| Alarm                       | Fires when                                                         | Look first                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submissions-dlq-not-empty` | ≥ 1 message in the dead-letter queue                               | Inspect worker logs and job state, then follow [controlled recovery](recovery.md). Old 311 messages can remain here; console polling is not read-only. |
| `submissions-queue-backlog` | oldest queued message > 10 min, 2 periods                          | `AnalyzerLatencyMs` p95 (slow analyzer) or `worker-lambda-errors` (redelivery churn).                                                                            |
| `<fn>-lambda-errors`        | invocation errors on api / worker / authorizer / intake            | the function's log group: `Task timed out`, `Runtime exited`, or a `level = "ERROR"` line.                                                                       |
| `<fn>-lambda-throttles`     | any throttle on api / authorizer / worker                          | api: reservation is 10 in `lambda.tf`. worker: the event-source cap should make this impossible.                                                                 |
| `worker-duration-high`      | worker p95 > 4 min (timeout 5 min)                                 | analyzer latency; a timeout is the next step.                                                                                                                    |
| `api-5xx`                   | > 5 gateway 5xx in 5 min                                           | `api_gw` access-log group: filter `status >= 500`, read `integrationErr`.                                                                                        |
| `dynamodb-throttles`        | any read/write throttle on the app table                           | a hot `SITE#` partition; Contributor Insights or the api logs at that minute.                                                                                    |
| `app-health-check`          | `/health` unreachable from Route53 for 3 min (missing data counts) | CloudFront → API Gateway → api Lambda, in that order.                                                                                                            |

## 311 alarms and metrics

[The 311 runbook](sf311.md) defines the dedicated queue/DLQ, connection,
reconciliation and terminal-action alarms, including inline calls and legacy
jobs. The alarm-status widget includes the new alarms; the fault-events chart
uses five-minute EMF sums from `-app`. Counts represent events, not unique jobs
or an unresolved backlog. Known handled 311 errors are excluded from generic
`ServerError`; uncaught API and platform errors remain monitored.

## Business metrics (namespace `good-neighbor-app-<env>-app`)

Emitted as CloudWatch Embedded Metric Format lines by `backend/src/lib/metrics.js`;
each line is also a normal log event with `marker` and ids, so Logs Insights answers
the "which check" question the metric cannot. Dimensions are deliberately few:
`Kind` (`photo` | `text`), `FlowType` (`perimeter` | `single-problem`),
`EvidenceKind` (`photos` | `description` | `mixed` | `none`).

| Metric                              | Dimensions                        | Emitted by                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CheckStarted`                      | FlowType                          | `handlers/checks.js` createCheck               | a new check header was written (idempotent replays do not count)                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CheckCompleted`                    | FlowType; FlowType + EvidenceKind | `handlers/checks.js` completeCheck             | the once-only closing write succeeded. Props: grade, issueCount, maxSeverity                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CheckPhotoCount`, `CheckTextCount` | same as CheckCompleted            | completeCheck                                  | evidence counts of completed checks (Sum ÷ CheckCompleted = average evidence per check)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AnalysisCompleted`                 | Kind                              | `workers/analyze-artifact.js`                  | an ANALYSIS# item was stored for the first time                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AnalyzerLatencyMs`                 | Kind                              | analyze worker                                 | wall-clock of one analyzer call, **every outcome** (so p95 includes slow failures)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AnalysisFailed`                    | Kind                              | analyze worker `markFailed`                    | permanent failure recorded (analyzer 4xx, media rejected, unsupported type). Prop `reason`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AnalysisRetried`                   | Kind                              | analyze worker                                 | transient analyzer failure; the message redelivers. Prop `reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AnalysisDuplicate`                 | Kind                              | analyze worker                                 | a redelivered message found the analysis already stored                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ThumbnailFailed`                   | Kind                              | analyze worker                                 | the card thumbnail could not be stored (`reason: store`) or recorded on the ART# row (`reason: record`); the card keeps using the original. Props `reason`, `error` (SDK error name). Not an analysis failure                                                                                                                                                                                                                                                                                                    |
| `LocationFallbackToSite`            | —                                 | `analysis/guidance/app-actions.js`             | a 311 filing used the site's point because the task had no photo position. Props `siteId`, `taskId`, `checkId`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `LateLocationAfterFiling`           | —                                 | `handlers/artifacts.js` updateArtifactLocation | a photo's late GPS fix arrived after its task was queued or filed for 311. Prop `filing`: `submitted` means the ticket kept the earlier point; `queued` means it may still get the fix, if the filing job reads the photo after this. Props `siteId`, `checkId`, `artifactId`, `taskId`. A task can be counted once per improving fix, so count distinct `taskId`. Expected near zero; if it shows up, late locations are a real problem and 311 tickets need a way to take a location that arrives after filing |

Useful ratios (metric math): failure rate `AnalysisFailed / (AnalysisCompleted +
AnalysisFailed)`; completion rate `CheckCompleted / CheckStarted`.

Logs Insights, worker log group:

```
fields @timestamp, marker, Kind, AnalyzerLatencyMs, reason, checkId, artifactId, siteId
| filter marker in ["AnalysisCompleted", "AnalysisFailed", "AnalysisRetried", "AnalyzerCall", "ThumbnailFailed"]
| sort @timestamp desc
```

Local dev and tests print the same lines without the `_aws` envelope
(`METRICS_NAMESPACE` unset), so nothing is ingested as a metric outside AWS.

## CloudWatch Omni (`infra/modules/app/omni.tf`)

Omni is AWS's web front end on the CloudWatch data this app already produces:
plain-language queries across the Lambda and API Gateway log groups, service
discovery, alerts to Slack or SNS, and shared investigation threads. It adds
nothing to ingestion and changes nothing about the alarms, dashboard, or
Logs Insights queries above. It is enabled per environment with
`enable_cloudwatch_omni` (dev on, prod off).

**Scope.** The AWS account hosts other applications, and Omni is scoped to an
account and Region (one space, one Dataset integration). Isolation is in IAM:

- `aws_iam_role.omni_forwarding` names each of this module's log groups in its
  `logs:IntegrateWithDataset` statement. Only those forward into Omni. Adding a
  Lambda means adding its log group to `local.omni_forwarded_log_group_arns`,
  the same way new functions must be added to the alarm maps.
- `aws_iam_role.omni_space_access` carries only `CloudWatchOmniSpaceAccessPolicy`.
  The Context Graph policy is deliberately not attached; it inventories every
  resource in the account.
- Metrics are read straight from CloudWatch Metrics and cannot be narrowed per
  namespace, so a space member can browse other applications' metrics.
  Membership is therefore the control: grants live in `cloudwatch_omni_members`.

**Signing in.** Sign in to the account the usual way (Identity Center, the
PowerUserAccess permission set) and open CloudWatch → Omni → the space; the
domain URL is also the `cloudwatch_omni_sign_in_url` output. That SSO sign-in
is a shared IAM role named `AWSReservedSSO_PowerUserAccess_<hash>`, and the
header shows it as `name / PowerUserAccess / <account id>`. Terraform looks the
role up by permission-set name (`cloudwatch_omni_sso_permission_sets`) and
grants it, so everyone who holds the set in that account can open the space.
Grants for a single IAM role or user go in `cloudwatch_omni_members`. The CI
deploy role is the first Space Admin automatically. Connecting the Identity
Center instance itself to the domain (`cloudwatch_omni_identity_center_instance_arn`)
is optional and needs the instance in the same Region as the domain; it is not
required for SSO users to sign in.

**Known limits, as of 2026-10-29.**

- The first enablement backfills up to 7 days of logs, but not from log groups
  encrypted with a customer managed key. All of ours are, so expect the space
  to start empty and fill from the moment forwarding begins. Confirm forwarding
  of KMS-encrypted log groups in dev before relying on it.
- Omni alerts are a separate system from the CloudWatch alarms in this runbook
  and do not appear in the console alarm list. Keep paging on the Terraform
  alarms; use Omni alerts for exploration only until a decision is made.
- The domain and space are created through a small CloudFormation stack
  (`aws_cloudformation_stack.omni`) rather than the provider's Omni resources,
  because only the CloudFormation types accept the CCSF tags today. Everything
  else in the file is plain Terraform with `var.tags`.

## Verifying after a deploy

1. Run one photo check and one description check against the environment.
2. CloudWatch → Metrics → `good-neighbor-app-<env>-app`: `AnalysisCompleted` shows both `Kind`
   values and `CheckCompleted` shows the matching `EvidenceKind` within a minute.
3. Alarms → all `good-neighbor-app-<env>-*` alarms are `OK` or `Insufficient data`, none `ALARM`.
4. Use the isolated production delivery drill above to verify notification routing.
   Use the [recovery runbook](recovery.md) for a synthetic dev DLQ rehearsal.
   Never purge a shared queue as a test-cleanup shortcut.
