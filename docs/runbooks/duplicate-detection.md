# Duplicate detection operations

## Deployment status and order

The code is ready for dev validation, but has not been deployed by the agent.
Use the repositories' CI pipelines; do not run Terraform plan/apply locally.

1. Deploy the analyzer comparison handler/contract and infrastructure first. Its
   dev stage selects `us.amazon.nova-lite-v1:0`, the inference profile used for the
   latest full Gubbio evaluation. Normal AnalyzeFn model selection is unchanged.
   Other stages retain the comparison construct's default unless explicitly configured.
2. Deploy app infrastructure with `enable_duplicate_detection=false`. Provision
   the dedicated comparison API key into the app's `duplicate-analyzer-key` Secrets
   Manager secret out of band. Never put the key into Git, Terraform variables,
   state, logs or a ticket. Set `duplicate_analyzer_base_url` if required.
3. Enable the dev flag through the normal CI configuration. The separate stream
   dispatcher indexes/warm-prepares uploads and queues analyses. The worker fills
   missing Site history metadata with paginated reads; it does not rerun analysis.
   The optional `bootstrap-duplicate-observations.mjs --site SITE_ID` maintenance
   command can pre-index and enqueue historical comparisons. It uses generation
   timestamps and includes text reports.
4. Capture distinct and repeated image/text issues. Check open-original notes,
   compact cards for repeats of in-progress originals, group actions, “Not a
   duplicate,” and timeline events. Test multiple conditions from one image and
   cross-Site isolation. Reload while a search is pending.

Existing local evaluation caches/reports are private temporary artifacts and are
not migration inputs or production ground truth. Live field accuracy still needs
human review. Normal analysis does not depend on duplicate queue availability.

## UI and API

`POST /v1/duplicates:batch` accepts up to 50 `taskIds`, derives the Site from the
principal, and returns pending/complete/unavailable/matched/separated states and current
original-issue metadata. Reads never invoke Bedrock. The browser polls separately
from analysis: initially every two seconds, then five seconds; settled groups use
30-second refreshes. A watcher stops after fifteen minutes and restarts on screen
entry/reload. Hidden documents do not poll. Backend matching continues independently.

`POST /v1/tasks/{taskId}/duplicate:separate` requires the displayed `sourceRevision`
and `originalTaskId`. A concurrent change returns 409. The durable override is keyed
by Site/check/artifact/condition, preventing later worker retries from relinking
that observation automatically. The original's completed action remains intact.

`GET /v1/checks/{checkId}/artifacts/{artifactId}/duplicates` remains available for
condition-level diagnostics. Product grouping uses the batch endpoint's validated
condition-to-task mapping, including the earliest valid original's short ID.

## Comparison key rotation

Rotate the comparison key manually in coordination with the analyzer service,
then update the app’s `duplicate-analyzer-key` secret out of band and verify a
comparison succeeds. Never record either key in logs, tickets, or Terraform.
Automatic rotation is not configured because the analyzer and app must agree
on the same credential.

## Dashboard tags

The pinned AWS Terraform provider's `aws_cloudwatch_dashboard` schema does not
support `tags`. Adding `tags = var.tags` fails validation. Dashboard ownership is
identified by the application/environment name prefix and this runbook; its
alarms and log groups retain the required CCSF tags. Revisit dashboard tagging
when the provider exposes it, rather than adding an out-of-band tagging script.

## CloudWatch

Dashboard: `<app-prefix>-duplicates`. Metric namespace: `<app-prefix>-duplicates`.
Event sources: `/aws/lambda/<app-prefix>-duplicate-worker` and
`/aws/lambda/<app-prefix>-duplicate-dispatch`. Both retain logs for 30 days; the
analyzer comparison log group also retains 30 days. API/normal-analysis log
retention is unchanged. User separations are emitted from the isolated stream
consumer rather than adding detailed events to longer-lived API logs.

- `DuplicateMatchedIssues`, `DuplicateNoMatchIssues`, `DuplicateIncompleteNoMatchIssues`, `DuplicatePendingIssues`:
  recorded per-issue outcomes of evaluations, potentially repeated on retries.
- `DuplicateLinksCreated`, `DuplicateSeparated`: link/override events, not a
  precision/accuracy rate. Link-chain changes can produce new link events.
- `DuplicateSearchMs`: worker search through result publication, excluding queue
  delay. `DuplicateFirstMatchMs`: worker start through first qualified positive
  publication, only for searches with such a result. Neither measures browser
  rendering or guarantees that an ancestor lookup is already complete.
- `DuplicateQueueMs`: observed enqueue-to-worker delay. The dashboard also shows
  SQS age/depth/dead letters. Queue depth includes preparation/reconciliation jobs.
- `DuplicateComparisons`, `DuplicateFailedCandidates`: valid and failed candidate
  attempts. A failed attempt is not evidence that two physical issues differ.
- Preparation/comparison cache-hit counts and worker attempts/failures are also
  emitted. IDs remain log properties, never billed metric dimensions.

Alarms use the app's existing SNS alarm topic: dead letters, at least five failed
worker attempts or failed candidate attempts in five minutes, and queue age over
fifteen minutes across two five-minute periods. These are operational thresholds,
not matching-confidence thresholds. Adjust after observing live volume.

Example Logs Insights query, without loading media or narratives:

```text
fields @timestamp, event, observationId, candidateId, conditionId,
       outcome, confidence, evidenceKind, modelId, matcherVersion
| filter event = 'duplicate_comparison' or event = 'duplicate_issue_result'
| sort @timestamp desc
| limit 100
```

Metrics cannot establish precision or recall without human-labelled positives and
negatives. A user separation is a correction signal, not necessarily a model error.
Stream/SQS delivery is at least once, so event totals may include retries.

Completed searches return no match only when no candidate qualifies and the
condition has no failed comparisons. Otherwise unmatched conditions return
unavailable. Internally, each
condition records `assessmentOutcome` and `failedCandidateCount`.
`no_match_with_failures` emits `DuplicateIncompleteNoMatchIssues`, separately from
`assessed_no_match` / `DuplicateNoMatchIssues`. These diagnostic distinctions do
not create automatic retries or leave the UI pending. A high-confidence match
remains a match even if a different candidate failed. Only candidate failures
with the source condition's category count against that condition.

## Media retention and rollback

The source uploads bucket and analyzer evidence bucket use 30-day expiration.
Prepared images live only under `duplicate-prepared/`, expire after three days,
and cannot be regenerated persistently in the original's final three retention
days. Missing authoritative S3 dates disable caching; expired original media is
not assessed even if asynchronous lifecycle deletion has not run yet. Old cache
entries lacking retention metadata are ignored. Comparison responses contain no
images and their DynamoDB cache has a five-day TTL. Issue history/links follow
normal application-record retention and contain no stored image bytes.

Disable `enable_duplicate_detection` through CI to stop new matching. Persisted
links and human overrides remain effective for existing groups. Do not delete
link/audit records to stop the workers. Normal analysis/guidance keep their own
queues, handlers and execution capacity. No image copies are sent to CloudWatch.

Full Lambda packaging must run on the Linux CI runner: the analytics packaging
step intentionally refuses a macOS-only DuckDB installation. The duplicate/API
entrypoints can still be bundled and checked locally.

Shared-action transactions retain all observed chain/revision/override guards.
If a chain would exceed DynamoDB’s transaction limits, the action fails closed
with 409 rather than executing against an unguarded original. Investigate unusually
deep chains before retrying; the reference walker separately caps traversal at 64.

## Local UI and backend integration

`npm run dev` now starts a separate `local:duplicates` process alongside the
existing normal worker. Configure the following in the ignored `.env.local`:

```dotenv
DUPLICATE_DETECTION_ENABLED=true
DUPLICATE_QUEUE_URL=http://localhost:9324/local/gnp-local-duplicates
DUPLICATE_ANALYZER_BASE_URL=http://127.0.0.1:4189/
DUPLICATE_ANALYZER_API_KEY=<local comparison server key>
```

The comparison URL may instead be the isolated deployed comparison service. The
normal `ANALYZER_BASE_URL` and `ANALYZER_API_KEY` remain separate. A local analyzer
comparison server runs the actual comparison handler and requires a valid AWS
profile for Bedrock; dummy MinIO credentials must not be passed to that process.
See the analyzer repository's `scripts/serve-image-comparisons.mjs` (set
`COMPARISON_PORT`, `COMPARISON_KEY_FILE`, `AWS_PROFILE`, `AWS_REGION` and
`COMPARISON_MODEL_ID`). Keep its generated key in ignored/private files only.

Start `npm run dev:frontend` separately and open `http://127.0.0.1:5173/`. The
seeded site code `GUBSJE` opens St. John the Evangelist. Submit an initial issue,
then another report of the same issue at the same site. Matching remains subject
to the real category, generation-time and confidence safeguards. A successful
comparison need not result in an automatic link if confidence is insufficient.

DynamoDB Local does not invoke Lambda stream consumers. The local bridge scans
records every 500 ms, delivers changed old/new images to the actual dispatcher,
and polls the dedicated queue with the actual worker. Failed dispatches retry;
failed jobs remain on the queue for redelivery after the 15-minute visibility
period. Restarting the bridge replays existing records, so duplicates and some
monitoring events may recur; durable handler guards still apply. This bridge is
local-only and does not change normal analysis handlers or deployed event wiring.
Its scan overhead and scheduling are not production latency measurements.

Local data persists in `backend/.local/`; this setup does not reset it. Use a
separate site for tests when needed. Logs are in the running process console,
including allowlisted duplicate outcomes and timings; local runs do not publish
CloudWatch log events. Real AWS IAM, event delivery, CloudWatch ingestion and S3
lifecycle deletion must still be verified after deployment.

## Independent frontend rollout flag

The public, authenticated site response includes
`site.featureFlags.duplicateDetection`. It defaults to false and controls display
only. It does not change the worker, persisted links, shared action routing or
human separation overrides. The UI fails closed when fresh settings cannot be
loaded; reload after changing the flag. Browser reloads fetch current settings.

The flag is stored on the site's `SITE#<siteId>` / `#META` DynamoDB item as the
boolean `featureFlags.duplicateDetection`. Missing, false, and non-boolean values
all fail closed. Change the item through an authorized operational or admin path;
the next site-settings request sees the change without a Terraform apply, Lambda
deployment, or frontend build. Preserve any other keys already present in the
`featureFlags` map when updating it.

Keep the backend `enable_duplicate_detection` Terraform flag independent. Backend
on/UI off permits operational observation before exposing the experience; disabling
the site flag affects presentation only and does not stop matching or unlink
persisted results.

With the UI off, duplicate polling stops, ordinary cards and actions remain,
and duplicate notes/cards, counts, check status, details/separation controls and
duplicate-specific timeline entries are hidden. Cached duplicate presentation
cannot override the flag. This is a presentation rollback, not an unlink operation;
backend actions on already-linked issues still use their confirmed original.

## Recovering stalled image comparisons

Prepared-image cache misses need `s3:ListBucket` on the uploads bucket: without
it, S3 masks a missing object as AccessDenied, so the worker cannot build the
cache. Keep real AccessDenied errors fatal/retryable; do not treat all permission
failures as cache misses. The duplicate worker alone receives this permission.

The batch API presents pending tasks older than fifteen minutes as `unavailable`.
This is a display state, not a negative match or cancellation. Completed searches
with failed candidates also show unavailable for the affected unmatched condition.
Confirmed matches still take precedence. At its fifteen-minute limit the browser
removes remaining pending spinners; reload restarts polling. Worker failures log
job IDs, job kind, exception name and receive count, never exception messages,
images, keys or narrative evidence.

After CI deploys the corrected infrastructure and worker, dry-run recovery for
each affected Site (including text reports with failed image candidates):

```bash
AWS_PROFILE=nst-dev AWS_REGION=us-west-2 \
DYNAMO_TABLE=good-neighbor-app-dev-app \
node backend/scripts/recover-duplicate-checks.mjs --site city-hall
```

Review the selected IDs, then run the same command with `--apply` and
`DUPLICATE_QUEUE_URL` set to the dev duplicates queue URL. Repeat for
`salvation-army-3110-octavia`, `st-john-the-evangelist`, and `moi-maanasa-sandbox`.
The command queries results, revalidates current analysis revisions, skips
analyses older than thirty days, and sends fresh jobs. It never resets results,
links, overrides or the DLQ. The worker independently checks authoritative media
retention and current revisions. Jobs are at-least-once; avoid repeated recovery
runs while a prior run is processing. This targeted recovery includes incomplete
completed searches that a DLQ redrive would miss.

Verify search-complete events, new prepared objects, and settled result states.
Investigate any `duplicate_worker_failed` events before retrying further. Keep the
DLQ messages for incident evidence until recovery is verified; do not blindly
redrive the shared DLQ, which can also contain stream-dispatch failure envelopes.
