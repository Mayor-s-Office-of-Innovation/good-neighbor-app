# Duplicate detection operations

## Deployment status and order

Duplicate processing is deployed in dev and prod. Environment configuration and
the deployed event-source mappings determine activation; the module default is
not evidence that a particular environment is disabled. The sequence below is
the provisioning/redeployment procedure, not a claim that live queues are unused.

Use the repositories' CI pipelines; do not run Terraform plan/apply locally.

1. Deploy the analyzer comparison handler/contract and infrastructure first. Its
   dev stage selects `us.amazon.nova-lite-v1:0`, the inference profile used for the
   latest full Gubbio evaluation. Normal AnalyzeFn model selection is unchanged.
   Both checked-in stages explicitly select that comparison model.
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

## Distinctive match evidence

A model's `same_issue` verdict and `strong` strength are insufficient for a
confirmed duplicate. Candidate evidence and each issue mapping must contain
issue-identifying support. The app rejects known generic category/scene-only
feature lists (for example, “litter on the sidewalk”) from high confidence,
including responses from an older analyzer. It continues searching later
candidates rather than stopping on those unsupported positives. The lexical
guard is deliberately narrow: unknown vocabulary does not by itself prove or
disprove identity, and field accuracy still requires human review.

Before publishing an image-backed high-confidence mapping, the combined matcher
compares each proposed condition pair independently in reversed photo roles,
using `purpose: visual_verification`. Only the two target descriptions and IDs
travel as locator hints; earlier verdicts, evidence and other context are omitted.
The analyzer must locate each intended target in its own image and return a
strong, visually grounded mapping for that exact reversed pair. Agreement on a
different issue in the same photos cannot confirm the target. Each mapping is
verified separately; successful corroboration never approves other mappings.
Rejected or uncertain corroboration is not a confirmed duplicate; a failed
request leaves the search incomplete rather than publishing a negative. The worker
reuses prepared images and its normal pacing/retry/cache path. Only pairs needed
to confirm still-unmatched source issues get an extra request. Budget one context
request plus one request per image-backed condition pair requiring verification;
negative searches do not pay this extra cost. Explicit markings such as `A-12`
are retained by the lexical guard; bare numbers, dates and generic counts do not
establish distinctive evidence.

Matcher version `issue-structured-v14` gives these comparisons a new cache digest,
so earlier comparison-cache responses cannot bypass the updated policy. Deploy
the analyzer's `issue-structured-v13` contract/prompt changes before the app;
an older analyzer rejects the new purpose and leaves the affected search incomplete.
No automatic re-evaluation of existing settled results occurs; any historical
recovery must be scoped and reviewed separately.

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
unavailable. The result endpoint returns `processingState: incomplete` and
`possibleDuplicate: null` for affected unmatched conditions, preserving any independently
verified positives. Failed candidates remain in `unassessedCandidateIds` as well as
`failedCandidateIds`, so attempted coverage cannot be confused with assessed coverage.
Internally, each condition records `assessmentOutcome` and `failedCandidateCount`.
`incomplete` (historically `no_match_with_failures`) emits `DuplicateIncompleteNoMatchIssues`, separately from
`assessed_no_match` / `DuplicateNoMatchIssues`. Historical failed-negative records are normalized on read without a backfill.
These distinctions do not create automatic retries or leave the UI pending. A high-confidence match
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

The batch API presents pending checks older than fifteen minutes as `unavailable`.
Timing uses the current revision’s queue timestamp (even before its observation
exists), falling back to analysis readiness when no result exists. Explicit
recovery records a new recovery timestamp; ordinary retries and API reads never
refresh the clock. Lifecycle redelivery preserves the event’s queue timestamp.
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
links, overrides or the DLQ. After enqueueing, it conditionally records
`recoveryRequestedAt` without overwriting concurrently completed results. The worker independently checks authoritative media
retention and current revisions. Jobs are at-least-once; avoid repeated recovery
runs while a prior run is processing. This targeted recovery includes `incomplete` aggregate statuses and condition
outcomes as well as historical `no_match_with_failures` results, which a DLQ
redrive would miss. The local evaluator uses the same processing-state helper for
its persisted progress and review report.

Verify search-complete events, new prepared objects, and settled result states.
Investigate any `duplicate_worker_failed` events before retrying further. Keep the
DLQ messages for incident evidence until recovery is verified; do not blindly
redrive the shared DLQ, which can also contain stream-dispatch failure envelopes.


## Shared comparison pacing and throttling recovery

Dev configures `duplicate_comparison_requests_per_second = 3`, below its dedicated
analyzer comparison usage-plan rate of 4/s (burst 8). This is an aggregate attempt
rate across workers sharing the app table and normalized endpoint, not a per-worker
rate. Every HTTP attempt, including retries, obtains a conditional DynamoDB permit.
Cache hits consume no permit. The gate serializes HTTP starts under a unique-owner
lease, then records the cooldown after starting the fetch. The response remains
concurrent with other requests. It does not reserve a long future queue or use
periodic batches. Contention waits have small jitter; DynamoDB failures fail closed.
A crashed owner blocks starts for at most its remaining lease (one pacing interval
plus five seconds). A delayed claim acknowledgement with less than one interval
remaining cannot start a request; it must reacquire. Cooldown writes are conditional
on owner identity so a stale owner cannot release or overwrite a newer lease.
Other applications, tools and API keys are not coordinated by this table's gate;
include their traffic when setting limits. Lambda clocks/network latency can also
vary, so pacing does not replace retry handling or gateway enforcement.

Only HTTP 429 responses retry: at most four total HTTP attempts, with exponential
250/500/1000ms backoff plus up to 250ms jitter. `Retry-After` seconds and HTTP dates
are honored as a minimum delay. Every comparison has one 60-second deadline covering
pacing, backoff, fetch and response-body consumption; each HTTP attempt retains its
27-second timeout. A long retry header expires the deadline instead of retrying early.
Non-429 errors, exhausted retries, deadlines and invalid responses remain failures;
they never become negative matches. The matcher still validates every success.

The module's default pacing rate is zero to preserve existing production configuration;
only dev opts in on this branch. Before production enablement, choose a measured rate
below that stage's effective limit and configure it explicitly. Do not copy dev's 3/s
setting into a production endpoint still limited to 1/s. Roll out through CI, then
verify queue age, comparison failures, gateway 429s and first-match/full-search latency.
The worker needs `UpdateItem` on the `DUP_COMPARISON_PACER` partition only; existing
`GetItem` permission supports consistent reads after a permit collision. No new table,
index, secret or cache-version change is required.

## Candidate fanout and worker sizing

One source photo is not one comparison request. The combined matcher sends up to
three candidate observations per request. With a three-candidate shortlist and
75 eligible observations in the same category over the preceding 72 hours, the
tested complete no-match search needed 25 requests. A smaller initial shortlist
can add a batch, and retries add attempts. A warm, qualifying match in the initial
three-candidate shortlist can stop after one. Cold history without visual hashes can defer a matching observation
until the last batch. Preserve full coverage and strict evidence checks when sizing
capacity; do not improve apparent throughput by silently truncating the history.

`duplicate_worker_maximum_concurrency` bounds simultaneous SQS workers independently
of the shared HTTP attempt gate. The module default remains two, preserving the
production setting. More workers overlap inference and reduce head-of-line queue
wait, but do not raise the configured three-attempts/second dev budget or parallelize
one source's sequential batches. Retries also consume that budget. A completed
worker result with failed candidates is not a successful full-search capacity test.

Size concurrency using measured request duration and complete source-search fanout,
then verify both queue-to-first-match and queue-to-completion latency. Higher
parallelism can increase permit contention, so retain the per-comparison deadline
and bounded retries. Test cold and warm histories, full no-match searches, and
mixed bursts; distinguish direct parallel Lambda tests from actual SQS delivery.
Only CI changes the deployed event-source mapping. Recheck queue age, worker and
analyzer errors, gateway 429 recovery, and DLQ growth after deployment.

The rollout planning range is 500 Sites × 3–5 checks/day × 3–5 photos/check, or
4,500–12,500 source photos/day before separate issue reports. At 12,500 photos/day,
25 requests/photo would require 312,500 successful comparisons/day before retries.
A three-attempts/second gate permits at most 86,400 attempts over eight hours,
or 259,200 over 24 hours. Over an eight-hour arrival window, the upper photo volume
therefore needs an average below 6.9 attempts/photo even before allowing headroom.
These are scenarios, not measured arrival distributions or a rollout guarantee.
Worker concurrency alone cannot remove a sustained request-rate deficit. Measure
actual category-filtered fanout, first-match frequency, cache benefit and retry/token
amplification before selecting production limits or enabling production detection.

Dev selects `duplicate_worker_maximum_concurrency = 20` with the existing 3/s
attempt gate. A controlled deployed-worker comparison of 8, 16, 20 and 32 parallel
workers found middle-80%-of-starts throughput of approximately 1.18, 2.43, 2.82 and
2.83 attempts/second respectively. Twenty workers used the available gate about
as well as 32 while avoiding the latter's additional contention. Whole-run rates
were lower because they include startup and drain. Each sizing job had twelve
same-category candidates (four sequential requests); the higher-concurrency tests
invoked the deployed Lambda directly and did not change the live SQS mapping.
After CI deploys the dev mapping, repeat the burst test through real SQS delivery.

The separate 75-candidate real-SQS controls observed one request and about eight
seconds of processing for a warm early match, versus 25 requests and about
160–165 seconds for full searches. With the old two-worker mapping, the late-match
control waited another 173 seconds before processing. These repeated-photo controls
establish request fanout and timing, not field accuracy or a full-rollout guarantee.
Initial calls used fresh comparison-cache keys; prepared images could be reused.

Two quality/reliability observations remain separate rollout gates: unexpected
high-confidence positives occurred in negative controls, and one three-candidate
batch failed schema validation in the 32-worker cohort after both analyzer
assessments. The worker retained failed-candidate diagnostics; treat this as an
incomplete search rather than a clean negative. The observation does not establish
that concurrency caused the model failure. Raising concurrency does not remediate
either issue. Before further production expansion, ensure the matching
controls and incomplete-batch behavior have been investigated and validated.


## Production configuration and activation

The production app configuration explicitly sets the comparison URL to
`https://xvcwo6m20a.execute-api.us-east-1.amazonaws.com/prod`, 20 SQS workers,
and a shared gate of three comparison attempts/second. These are the measured dev
baseline for validation, not a full-rollout capacity guarantee. The analyzer
production stage prepares 128 comparison Lambda slots and a four-request/second,
burst-eight dedicated comparison usage plan. Normal analysis controls are separate.
Account/model quotas and Lambda reservation headroom remain deployment prerequisites.

Production configuration now enables `enable_duplicate_detection`. Site flags
control presentation separately from background processing. For a future staged
rollout, deploy with processing disabled until the
representative dev load tests and controlled fanout/recovery checks,
matching-quality review and production permission/quota checks are accepted.
Backend activation applies to every Site: the dispatcher and worker do not enforce
an allowlist. Selected Site flags limit presentation only, so a UI pilot still
requires capacity approval for all Sites' backend processing. A pilot that limits
backend workload requires an enforced Site allowlist before activation; the
presentation flag cannot provide that isolation.

The comparison cache namespace is scoped to production through
`duplicate_comparison_cache_version = "image-comparison-v2"`. Dev and the shared
module default keep `image-comparison-v1`. The new namespace prevents reuse of old
comparison responses in production; it does not delete rows, invalidate prepared
images or re-evaluate completed results. Use site-scoped recovery for any completed
incomplete results that need a fresh evaluation. Reverting the namespace can expose
older cached responses again; normally keep v2 even when disabling detection.

Deployment and activation order:

1. Promote/deploy the analyzer through its production pipeline. Before applying,
   verify available Lambda reservation headroom (including dev reservations) and
   account-specific Nova cross-region request/token quotas. After deployment, verify
   the production comparison model, IAM, dedicated usage plan and endpoint.
2. Obtain the dedicated production `ComparisonCallerApiKeyId` from the analyzer's
   production stack. Securely populate the app production `duplicate-analyzer-key`
   secret out of band with that key's value. Do not use the normal analyzer key or
   the dev comparison key. Terraform creates the encrypted secret container only;
   no secret value belongs in source, tfvars, state, logs or command-line arguments.
3. Promote/deploy this app configuration with detection still disabled. Verify
   the effective URL, secret access, cache namespace, 20-worker mapping and 3/s gate.
   An inactive mapping cannot establish end-to-end readiness by itself.
4. Before backend activation, decide which Sites need the optional history bootstrap
   and confirm same-site/category history coverage for the intended rollout. When
   bootstrap is needed, run `bootstrap-duplicate-observations.mjs --site SITE_ID`
   while both the stream dispatcher and SQS worker event-source mappings are disabled.
   Confirm each site-scoped run succeeds, including its coverage marker, before
   proceeding. Bootstrap can enqueue historical comparisons, so include that work in
   the activation capacity assessment. Do not run it concurrently with live workers.
5. Once release gates and capacity approval for all Sites' backend processing are
   accepted, enable the production backend flag through CI. Qualifying records from
   all Sites can then enter comparison processing, including Sites with UI flags off.
   For a selected-Site UI pilot, set each selected Site's
   `featureFlags.duplicateDetection` to true while preserving all other flags.
   Verify polling, recovery and separate/unlink behavior before expanding presentation.
6. Monitor first-match/full-search latency, queue age, comparison/model failures,
   429 amplification and DLQ growth before expanding. The site flag rolls back
   presentation; disabling the backend flag through CI stops new matching work.
   Neither action purges queues, deletes links or reverses completed user actions.
