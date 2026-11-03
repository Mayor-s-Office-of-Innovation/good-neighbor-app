# Runbook: client analytics events (page views, device facts, camera hand-offs)

**Scope:** `frontend/src/services/analytics.js` → `POST /v1/client-events` → **API Gateway writes
the body to the `client-events` SQS queue** → **consumer Lambda**
(`backend/src/lambda/client-events-consumer.js`) → PostHog as plain named events. No Lambda sits in
the request path; see [Transport](#transport-2026-11). No vendor SDK ships in the app. This is the
sibling of the error-tracking pipeline (`/v1/client-errors`, `$exception` events) and the feedback
pipeline (`/v1/feedback`, see [feedback-ops.md](./feedback-ops.md)), which still run in the intake
Lambda; all three share the same PostHog project key and the same log-only default.

## Why it exists (2026-10)

Field testing on older Android devices showed users returning from the camera to the home
screen instead of the active check. The browser was being killed while the camera was in the
foreground and relaunched at the entry URL. Error tracking cannot see that, and it carries no
browser or device detail for a healthy session. This pipeline gives every device a page-view
trail with browser, OS, screen, memory, and model attached, plus the specific events that
bracket the hand-off.

## Events

| Event | Fired by | Properties beyond the device facts |
|---|---|---|
| `$pageview` | every route landing (`main.js` → `startPageViewTracking`) | `$current_url` (origin + pathname, never the query), `$pathname`; first view of a document also carries `navigation_type` (`navigate` / `reload` / `back_forward`) and `$referring_domain` |
| `site_setup_completed` | `app-root` on `sitebound` | `switching_site` |
| `camera_opened` | `perimeter-check` / `problem-report` `_openCamera` | `flow` |
| `photo_picked` | the file input's `change` | `flow`, `photo_bytes`, `photo_type` |
| `photo_location` | `services/device-location.js` once the capture's position read settles, per photo | `flow`, `location_outcome` (`acquired` / `timeout` / `denied` / `unavailable` / `skipped`), `location_wait_ms` (until the read settles, which may be after the upload), `location_accuracy_m` (rounded; acquired only), `location_sent_with_upload` (acquired only: true if the location went with the photo, false if it followed by PATCH), `permission_state` (`granted` / `prompt` / `denied` / `unsupported`). Never coordinates |
| `capture_resumed` | `app-root` boot when a check is auto-resumed after a relaunch | `route`, `flow`, `marker_age_s`, `navigation_type`, `landing_path`, `$referring_domain` |
| `handoff_grant_issued` | `services/session-handoff.js` when iOS Safari mints a Home Screen handoff grant | — |
| `handoff_redeemed` | `app-root` on the installed app's first launch, after the grant bought a session | — |
| `handoff_failed` | `app-root` when that redemption failed | `reason` (`rejected` / `network` / `error` / `storage`) |
| `handoff_stale_ignored` | `app-root` when the launch URL still carried a grant but a session already existed | — |

A `camera_opened` with no `photo_picked` after it, followed by a `$pageview` with
`navigation_type=navigate` on `/today` and then a `capture_resumed`, is the Android relaunch
signature.

**Device facts on every event.** From the client: `$screen_width/height`, `$viewport_width/height`,
`device_pixel_ratio`, `$browser_language`, `device_memory_gb`, `hardware_concurrency`,
`connection_type`, `display_mode` (`standalone` / `browser`), `platform`, `ua_mobile`, and the UA
client hints `platform_version` and `device_model` where the browser grants them. From the server,
parsed out of the `user-agent` header (`backend/src/lib/user-agent.js`): `$browser`,
`$browser_version`, `$os`, `$os_version`, `$device_type`, `android_webview`, `$raw_user_agent`.
Events are anonymous (`$process_person_profile: false`); the shared `gnp:distinct-id` groups them
per browser alongside errors and feedback.

## Allowlists (the only things the pipeline can carry)

Event names and property keys are allowlisted in
`backend/src/handlers/scrub-client-event.js`. Anything else is dropped at intake, and URL-ish
values are query-stripped again server-side. Adding an event or property means adding it there
(and its test) first; the client cannot widen what is accepted.

## Kill switches

- Per device: `localStorage['gnp:analytics'] = 'off'` (`'on'` forces it on, including under tests).
- Globally: the forwarder is log-only whenever the PostHog project key is unset (same secret as
  error tracking, [feedback-ops.md §2](./feedback-ops.md)). Log-only still writes every event and
  its device properties to CloudWatch, so the device picture is available before egress is on.
- WAF: `ClientEventsRateLimit` blocks an IP above 5,000 requests per 5 minutes on this path. The general WAF traffic budget can block first.
- Concurrency: the three intakes (errors, events, feedback) run in their own `good-neighbor-app-<env>-intake`
  Lambda with reserved concurrency of 50, separate from the app API function. Each handler
  awaits its PostHog forward before answering. The reservation bounds concurrent intake work
  across IPs; WAF bounds requests per IP. Slow PostHog responses can occupy the intake slots
  and cause dropped beacons. The event forwarder gives up after 1 s (`EVENT_FORWARD_TIMEOUT_MS`); errors and feedback keep 3 s.

## Transport (2026-11)

In deployed environments the route is an API Gateway **SQS-SendMessage** service integration
(`infra/modules/app/client-events.tf`): the gateway puts the raw body on the `<env>-client-events`
queue, tags it with a constant `Kind` message attribute (`client-event`), and rewrites SQS's 200
to the 204 the client expects. `POST /v1/client-errors` uses the same queue and consumer with
`Kind=client-error`; the consumer runs the error scrub and the `$exception` forwarder for those,
one PostHog call per kind per invocation. The user agent
travels inside the body (`ua`), because the only way for the gateway to attach a header would be
to splice it into a JSON mapping it cannot escape; the server reads `ua` first and falls back to
the header on the HTTP path for older cached clients. The consumer Lambda reads up to 100 bodies per invocation (5 s
batching window, 5 concurrent at most), scrubs each with `handlers/client-events-batch.js`, and
sends every event in the invocation to PostHog in one `/batch/` call with a 5 s budget.

What this buys over the old intake-Lambda path:

- **No request-path Lambda.** Beacon bursts cannot be throttled by PostHog latency or by a
  concurrency reservation; SQS absorbs them.
- **Durability.** A failed PostHog call reports the messages that carried events as batch item
  failures; SQS redelivers them (visibility timeout 180 s) up to 5 times, then parks them in
  `<env>-client-events-dlq` (14-day retention). Garbage bodies are acknowledged, not retried.

What stays the same: the HTTP handlers (`handlers/client-events.js`, `handlers/client-errors.js`)
still serve `npm run dev` and are still wired in `lambda/intake.js`, which in deployed environments
now receives only `/v1/feedback`. Pointing a route back at the intake integration restores the old
path with no code change.

Alarms added with the queue: `client-events-dlq-not-empty` (any dead letter) and
`client-events-queue-stale` (oldest message over 10 minutes: the consumer is not keeping up or not
running). Redrive the DLQ from the SQS console once forwarding works; a redelivered batch that had
partly reached PostHog produces duplicate events, which is harmless analytics noise.

## Batching (2026-11)

The client queues events and sends them as one beacon, `{ batch: [event, ...], ua }`, after a 2 s
quiet period, before the serialized batch would exceed 6 KiB (about eight `photo_pipeline`
events), at 25 events, or when the page is hidden or unloading (`flushEvents` in `analytics.js`).
The byte budget exists because the WAF blocks bodies over the managed 8 KiB limit on this path
(`SizeRestrictions_Body`, `main.tf`); a bigger batch would be rejected with a 413 and lost. The intake scrubs each item, drops invalid ones (one `ClientEventDropped` line
with `received` / `dropped` counts), caps a request at 50 items, and forwards the batch to
PostHog in a single `/batch/` call. A single-event body is still accepted. The drop line is
per request, not per item (`invalid` and `truncated` give the breakdown), so the
`ClientEventDropped` alarm counts requests carrying garbage rather than items.

Why: a four-photo perimeter check emits roughly 55 events (`camera_opened`, `photo_picked`,
`photo_location`, and `started` + `completed` for each of the five `photo_pipeline` stages per
photo, plus page views). With one beacon per event, a 2026-11-01 load test saw 4 concurrent
users produce ~100 concurrent intake invocations, each held for a PostHog round trip, and the
function throttled. Throttling only drops telemetry (the app never waits on it), but it drops
exactly the field data the pipeline exists to collect. Batched, a check costs a few invocations.

Isolation is unchanged: `trackEvent` only queues, the flush runs from a timer or a lifecycle
listener and swallows every error, a batch the browser or intake refuses is dropped rather than
retried, and the intake still answers 204 whatever happens.

## Is it working? (CloudWatch, consumer log group `/aws/lambda/good-neighbor-app-<env>-client-events-consumer`)

One structured line per event (a batch logs one line per event it carried, each with
`batch_size`). The same markers appear in the intake log group for the local/fallback HTTP path, and
both log groups feed the same metric filters and alarms:

| Marker | Meaning |
|---|---|
| `ClientEventLogOnly` | Key not set. Validated and logged with properties, never sent. |
| `ClientEventForwarded` | PostHog accepted the batch. |
| `ClientEventForwardFailed` | Secret read, PostHog ingest, or the 1 s budget failed (WARN). Carries the event and its device properties, so nothing is lost for investigation. Alarms at ≥10 per 5 min. |
| `ClientEventDropped` | Payload rejected by the scrubber (WARN). |

Logs Insights:

```
fields @timestamp, marker, event, properties.$os, properties.$os_version, properties.$browser, properties.device_model, properties.$pathname
| filter marker like /ClientEvent/
| sort @timestamp desc
```

If `ClientEventLogOnly` dominates, the key was never put in Secrets Manager and nothing has
reached PostHog. In PostHog, the events appear under Activity with `$lib = gnp-client-events`;
`$pageview` feeds the Web Analytics views directly.

### Intake configuration failures

The standalone intake Lambda reads only PostHog key settings and optional feedback
survey identifiers through `getPosthogConfig()`. It does not require the main API's
`S3_UPLOAD_BUCKET`, `SQS_QUEUE_URL`, or `DYNAMO_TABLE`. Keep these dependencies
separate rather than adding unrelated infrastructure settings to the intake Lambda.

A forwarding warning with `reason = "secret_fetch_failed"` and a message such as
`Missing required environment variable for uploadBucket` indicates the old shared
configuration dependency failed before Secrets Manager was called. Deploy the
intake configuration fix; this message alone does not indicate a bad PostHog key
or missing Secrets Manager permission.

After deployment, generate a dev analytics event, client error, and feedback submission
(with feedback survey IDs configured). Check the intake logs for
`ClientEventForwarded` and `ClientErrorForwarded`, then verify all three events
in PostHog. Feedback has no success log marker; confirm its `survey sent` event
in PostHog and check for `FeedbackForwardFailed` or `FeedbackLogOnly` in CloudWatch. A 204 intake response alone is not confirmation:
the handlers also return 204 in log-only mode and on forwarding failures.
Previously failed beacons are not automatically replayed.

## Local development

`npm run dev` (backend harness) serves `POST /v1/client-events` through the HTTP handler and the
Vite proxy forwards it, so beacons land in the harness log. There is no local queue; the harness
path and the deployed path share the unpack/scrub module and the forwarder, and differ only in the
SQS hop. Under vitest the service is off unless forced on.

## Photo upload and analysis diagnosis

`photo_pipeline` events trace `presign` → `put` → `register` → `analyze` →
`evaluate`. Each stage emits `started` and `completed` or `failed`; analysis also
reports `backend_failed`, `timeout`, or `cancelled`. A stage still pending after
30 seconds emits one `slow` event. This observes the existing pipeline without
changing its timeouts or retry behavior.

Use `attempt_id` to group upload-stage events; retries receive a fresh ID. Use
`check_id` and `artifact_id` to join registration, analysis, and worker logs.
Analysis/evaluation receive a separate attempt ID so re-polling is distinguishable.
`elapsed_ms` measures that stage, `photo_bytes` is the upload size, and
`http_status` is the failure response status (0 means no HTTP status available).
`online` is the browser's connectivity hint, not proof of internet access;
`visibility` records whether the document was visible when the event was emitted.
Existing browser, OS, connection-type, and release fields accompany every event.
No image content, location, free-form error, S3 key, or signed URL is included.

In CloudWatch, select the dev/prod intake Lambda log group:

```
fields @timestamp, marker, properties.check_id, properties.artifact_id,
  properties.attempt_id, properties.stage, properties.outcome,
  properties.elapsed_ms, properties.http_status, properties.online,
  properties.visibility, properties.photo_bytes
| filter event = "photo_pipeline"
| sort @timestamp asc
```

In PostHog, filter the `photo_pipeline` event by `check_id` or `artifact_id`, then
inspect stages/outcomes and compare browser/release cohorts. `put` completed with
no `register` completion localizes the gap between upload and enqueue. An
`analyze` timeout with a successful worker result points to result retrieval;
`backend_failed` indicates the worker recorded a failed analysis.

Delivery is best effort through the existing analytics intake and respects
`gnp:analytics=off`. An offline/killed browser may lose events; a missing terminal
event alone does not prove failure. Slow-event timers can be delayed while the
browser is suspended. Compare against S3 object metadata and worker logs. CloudWatch
retains accepted events even if PostHog forwarding fails. Deploy the intake
allowlist before or alongside the frontend; older intakes drop the new event.
