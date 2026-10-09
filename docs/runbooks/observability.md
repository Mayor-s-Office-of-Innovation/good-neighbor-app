# Runbook: observability (alarms, business metrics, uptime)

**Scope:** what pages, what the business metrics mean, and where to look first. CloudWatch is the
operational source of truth ([ADR 0008](../adr/0008-lean-client-error-capture.md));
PostHog carries client errors, page/camera events and feedback only
([client-events.md](./client-events.md), [feedback-ops.md](./feedback-ops.md)); the
analytics lake ([ADR 0013](../adr/0013-analytics-read-plane.md)) serves stakeholder
reporting and trails live data by about 6 hours.

## Who gets paged

Both SNS topics subscribe the same `alarm_emails` list, set per environment in
`infra/environments/<env>/main.tf`. Every address gets one confirmation email **per
topic** (two in total) and is silent until confirmed.

| Topic | Region | Why it exists |
|---|---|---|
| `gnp-<env>-alarms` | us-west-2 | every code-marker alarm (`alarms.tf`) and every platform alarm (`platform-alarms.tf`) |
| `gnp-<env>-alarms-us-east-1` | us-east-1 | metrics that only exist there: the Route53 uptime check and the CloudFront-scoped WAF rule |

## The dashboard (`infra/modules/app/dashboard.tf`)

CloudWatch → Dashboards → `gnp-<env>-ops`, opening on the last 24 hours. Rows, top to
bottom: alarm status for every home-region alarm · activity (checks started vs completed,
completed perimeter checks by evidence, analyses by kind) · analyzer (latency p50/p95,
failed/retried/duplicate, failure rate) · pipeline (queue depth, in flight, dead-lettered,
oldest-message age; worker invocations, errors, throttles, concurrency, duration) · API
Gateway and request-path Lambdas · uptime from Route53, the code-reported fault metrics,
and CloudFront WAF allowed vs blocked. Alarm thresholds are drawn as red/orange lines on
the widgets they guard. The two us-east-1 alarms (uptime, WAF rate limit) are not in the
alarm-status widget, which is same-region only; their metrics are the bottom row.

## Platform alarms (`infra/modules/app/platform-alarms.tf`)

| Alarm | Fires when | Look first |
|---|---|---|
| `submissions-dlq-not-empty` | ≥ 1 message in the dead-letter queue | SQS console → DLQ → poll a message (ids only, never media) → worker log group, `level = "ERROR"` around that time. Fix, then **Start DLQ redrive** on the queue. |
| `submissions-queue-backlog` | oldest queued message > 10 min, 2 periods | `AnalyzerLatencyMs` p95 (slow analyzer) or `worker-lambda-errors` (redelivery churn). |
| `<fn>-lambda-errors` | invocation errors on api / worker / authorizer / intake | the function's log group: `Task timed out`, `Runtime exited`, or a `level = "ERROR"` line. |
| `<fn>-lambda-throttles` | any throttle on api / authorizer / worker | api: reservation is 10 in `lambda.tf`. worker: the event-source cap should make this impossible. |
| `worker-duration-high` | worker p95 > 4 min (timeout 5 min) | analyzer latency; a timeout is the next step. |
| `api-5xx` | > 5 gateway 5xx in 5 min | `api_gw` access-log group: filter `status >= 500`, read `integrationErr`. |
| `dynamodb-throttles` | any read/write throttle on the app table | a hot `SITE#` partition; Contributor Insights or the api logs at that minute. |
| `app-health-check` | `/health` unreachable from Route53 for 3 min (missing data counts) | CloudFront → API Gateway → api Lambda, in that order. |

## Business metrics (namespace `gnp-<env>-app`)

Emitted as CloudWatch Embedded Metric Format lines by `backend/src/lib/metrics.js`;
each line is also a normal log event with `marker` and ids, so Logs Insights answers
the "which check" question the metric cannot. Dimensions are deliberately few:
`Kind` (`photo` | `text`), `FlowType` (`perimeter` | `single-problem`),
`EvidenceKind` (`photos` | `description` | `mixed` | `none`).

| Metric | Dimensions | Emitted by | Meaning |
|---|---|---|---|
| `CheckStarted` | FlowType | `handlers/checks.js` createCheck | a new check header was written (idempotent replays do not count) |
| `CheckCompleted` | FlowType; FlowType + EvidenceKind | `handlers/checks.js` completeCheck | the once-only closing write succeeded. Props: grade, issueCount, maxSeverity |
| `CheckPhotoCount`, `CheckTextCount` | same as CheckCompleted | completeCheck | evidence counts of completed checks (Sum ÷ CheckCompleted = average evidence per check) |
| `AnalysisCompleted` | Kind | `workers/analyze-artifact.js` | an ANALYSIS# item was stored for the first time |
| `AnalyzerLatencyMs` | Kind | analyze worker | wall-clock of one analyzer call, **every outcome** (so p95 includes slow failures) |
| `AnalysisFailed` | Kind | analyze worker `markFailed` | permanent failure recorded (analyzer 4xx, media rejected, unsupported type). Prop `reason` |
| `AnalysisRetried` | Kind | analyze worker | transient analyzer failure; the message redelivers. Prop `reason` |
| `AnalysisDuplicate` | Kind | analyze worker | a redelivered message found the analysis already stored |

Useful ratios (metric math): failure rate `AnalysisFailed / (AnalysisCompleted +
AnalysisFailed)`; completion rate `CheckCompleted / CheckStarted`.

Logs Insights, worker log group:

```
fields @timestamp, marker, Kind, AnalyzerLatencyMs, reason, checkId, artifactId, siteId
| filter marker in ["AnalysisCompleted", "AnalysisFailed", "AnalysisRetried", "AnalyzerCall"]
| sort @timestamp desc
```

Local dev and tests print the same lines without the `_aws` envelope
(`METRICS_NAMESPACE` unset), so nothing is ingested as a metric outside AWS.

## Verifying after a deploy

1. Run one photo check and one description check against the environment.
2. CloudWatch → Metrics → `gnp-<env>-app`: `AnalysisCompleted` shows both `Kind`
   values and `CheckCompleted` shows the matching `EvidenceKind` within a minute.
3. Alarms → all `gnp-<env>-*` alarms are `OK` or `Insufficient data`, none `ALARM`.
4. To test paging in dev: send any message to the DLQ from the SQS console; the
   `submissions-dlq-not-empty` email arrives within 5 minutes; purge the DLQ after.
