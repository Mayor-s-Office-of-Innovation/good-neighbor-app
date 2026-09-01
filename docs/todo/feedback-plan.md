# Plan: user feedback → PostHog Surveys (own intake, CloudWatch fallback)

Status: **approved — Phases 1–3 built; Phase 5 (PostHog destination) designed, not started.**
Date: 2026-08-31 · Amended 2026-09-01 (PostHog Surveys destination — see [Phase 5](#phase-5--posthog-surveys-destination))
and [Amendment history](#amendment-history).

**In one sentence:** a tiny in-app feedback form posts to our own API route; the
api Lambda scrubs it, forwards it to **PostHog as a `survey sent` event**
(read in PostHog's Surveys tab, with theme clustering via Self-driving), and
logs **metadata only** (`FeedbackReceived` marker — arrival/abuse/forward
signals for the alarms; **never the message text**). PostHog is the feedback
store; CloudWatch is the operational-signal plane, not a content store.

**Decisions (settled 2026-08-31):** the form is **textarea-only** (no category
picker, no rating); **no reply channel** — feedback is anonymous, no contact
fields; **no DynamoDB migration** — see below for the PostHog destination;
SNS recipients are **managed in the AWS console** per environment, not in
Terraform (nothing here subscribes addresses; the existing empty-default topic
just sits ready).

**Amendment decisions (settled 2026-09-01):** the feedback destination is
**PostHog Surveys** via a `survey sent` event on the existing server-side
forwarder pattern. **Egress sign-off: GRANTED (MOI, 2026-09-01)** — explicitly
covering storage of this feedback in PostHog *without PII obfuscation*; scope
as recorded by product: submissions come from **app administrators** (bug
reports and product notes), and the data will **never be exposed to non-city-
affiliated staff**. **CloudWatch no longer stores feedback content**: once
PostHog is the destination, the `FeedbackReceived` log line carries metadata
only (markers, page, site, release, id, UA, textLength — never `text`), so the
message exists solely in PostHog. The forwarder ships **log-only until the
survey IDs are configured** — the built-and-verified default, the local-dev
behavior, and the rollback switch, exactly mirroring the error forwarder's
semantics.

## The decision

We want staff to send feedback about the app. Constraints that shaped this:

- **No outbound email yet** — so no "email us the form" path, and no SES.
- **Minimal new infrastructure** — one route, one handler, one alarm, riding
  resources that already exist.
- Feedback is user content, so egress needed an explicit sign-off — **granted
  2026-09-01 for PostHog** (see Amendment decisions). Before that, the design
  deliberately kept everything in CloudWatch (KMS-encrypted, existing IAM,
  365-day retention — `infra/modules/app/lambda.tf:17-22`), and that path is
  retained as the always-on fallback.

This is deliberately the same architecture as the client-error intake
([client-error-tracking-plan.md](./client-error-tracking-plan.md)): validate →
scrub → structured log → (optional, signed-off) server-side forward. Phase 5
adds the forwarder leg; the CloudWatch leg stands on its own.

```
Browser  (feedback form: textarea + auto-attached context)
  │  POST /v1/feedback                      (same-origin, CSP unchanged)
  ▼
api Lambda  (validate + scrub + size-cap; never signal validity to abusers)
  │  console.log one metadata-only JSON line: marker "FeedbackReceived"  (no text)
  │  forward to PostHog as `survey sent`        ← log-only until
  │    └─ no key / no survey IDs → stay log-only  survey IDs are configured
  ▼
PostHog (us.i.posthog.com) — THE STORE            CloudWatch (signals only)
  Surveys results tab + Self-driving               ├── FeedbackReceived → SNS arrival ping
  theme clustering, dashboards, Slack              ├── FeedbackDropped → abuse counter
                                                   └── FeedbackForwardFailed → page
```

## Scope

| Phase | What | Status |
|-------|------|--------|
| 1 | Backend: route (3 places), intake handler + scrubber, tests, WAF rate rule | **Built** (2026-08-31) |
| 2 | Frontend: `feedback.js` service + minimal form UI (today view), tests | **Built** (2026-08-31) |
| 3 | Terraform: `FeedbackReceived` metric filter + SNS email alarm (+ abuse counter) | **Built** (2026-08-31) |
| 4 | Verify E2E in dev, saved-query bookmark, docs index + MVP-TODO updates | In this plan |
| 5 | PostHog destination: survey setup + `survey sent` forwarder + env config | **Built** (2026-09-01); log-only until Phase 5a survey IDs set |

Out of scope (explicitly): contact-info / reply-to fields (settled — none, see
Decisions), feedback *categories* or star ratings (settled — textarea only),
an admin UI for reading feedback, offline queueing of feedback (contradicts the
deferred-offline decision in ADR 0005 / AGENTS.md — a lost offline feedback is
an acceptable loss), the posthog-js SDK (server-side capture only, per the
error-tracking plan's CSP invariant), and PostHog survey *rendering* in-app
(our own dialog is the form; PostHog is only the store/analysis plane).

---

## Phase 1 — backend route + intake

**Terraform** (`infra/modules/app/api.tf`, `main.tf` WAF):

- Add `POST /v1/feedback` to `local.api_routes`. Register it in **all three**
  places (per the repo's API contract): the Terraform route set
  (`api.tf`), the `routes` table in `backend/src/lambda/api.js`, and
  `backend/scripts/local-api.mjs`.
- **Abuse guard: WAF rate-based rule** scoped to the path, copying the
  `ClientErrorsRateLimit` pattern (`infra/modules/app/main.tf:586-620`):
  `RateLimit`-style `rate_based_statement` with a byte-match scope-down on
  `/v1/feedback`, limit **20 requests/5min/IP** (honest single submissions are
  rare; the client throttles too). No CloudFront or API Gateway changes
  otherwise.

**Scrubber** — `backend/src/handlers/scrub-feedback.js`, modeled on
`scrub-client-error.js` (never trust the client; allowlist-only):

- `message` — required string, trimmed, **capped at 2,000 chars**; rejects
  empty/whitespace-only.
- `page` — optional short string ≤ 200 chars (a bare pathname from the client;
  query-string-stripped like `source` in the error scrubber, defense in depth).
- `site` — optional short string ≤ 32 chars, pattern-restricted to site-code
  shape (`/^[A-Z0-9-]{4,32}$/`); dropped if it doesn't match.
- `release` / `id` / `ts` — optional short strings ≤ 200 chars (auto-attached
  by the client service; `id` is the same random per-browser UUID as
  `error-report.js` reuses from `localStorage['gnp:distinct-id']`).
- Everything else in the payload is **dropped**, not forwarded. Non-strings
  coerced per the `truncateString` convention. Garbage input → `null`.

**Intake handler** — `backend/src/handlers/feedback.js`, modeled on
`client-errors.js` and sharing its contract posture:

1. Read + parse JSON body (tolerantly, like `readJsonBody` usage there).
2. `scrubFeedbackReport(body)` — `null` on garbage.
3. Valid: `console.log` **one compact metadata-only JSON line** (single
   `console.log` call so it is always one line). **No message text** — the
   original Phase-1 design logged `text` because CloudWatch was the store;
   with PostHog as the destination (2026-09-01 amendment) the message must
   exist only there, so the line carries signals, not content:

   ```json
   {"level":"info","marker":"FeedbackReceived","ts":"<intake ISO>","page":"/today",
    "site":"M0101","release":"abc1234","id":"<uuid>","userAgent":"<from headers>",
    "textLength":183}
   ```

   `textLength` preserves a rough size signal for the metadata plane without
   the content. User-agent is read server-side from headers (reuse the
   `readUserAgent` helper idea from `handlers/client-errors.js:55-72`).
4. Then `forwardFeedback(...)` (Phase 5) hands the full scrubbed submission —
   text included — to the PostHog forwarder. Outcome never affects the
   response; failures land as `FeedbackForwardFailed` WARNs.
5. Invalid payloads get a quiet-but-counted drop line (`marker: "FeedbackDropped"`,
   `logServerError`'s structured style, mirroring `DROPPED_MARKER`) so the
   metric filter has an abuse signal — silent drops would hide exactly what we
   alarm on.
6. **Always respond 204**, never signal validity to a possible abuser.

Local dev: the `local-api.mjs` route logs the same line to the dev terminal;
no mock infra needed. `.env` needs nothing — no keys, no secrets.

**Tests** (Vitest, dependency-free per repo convention): handler validation
table-tests (missing/empty/too-long message → 204 + `FeedbackDropped` line),
scrubber cases (allowlist-only output, `page` query-strip, `site` pattern
rejects, non-string coercion), happy path emits exactly one
`FeedbackReceived` line **asserting `text` is absent** (the amendment's
security property) and the forwarder received the full text, always-204
property.

## Phase 2 — frontend: service + form

**`frontend/src/services/feedback.js`** (~40 lines, no deps), following the
`error-report.js` conventions (no-throw, no-op-safe, scrubbed):

- `sendFeedback({ message })` — attaches
  `{ page: pathnameOnly(), release, id: distinctId(), ts }` from the same
  helpers/conventions as `error-report.js` (same localStorage key for the
  distinct id), caps `message` at 2,000, and POSTs JSON to
  `/v1/feedback` with the **api base URL resolution used by `services/api.js`**
  (so dev/prod bases both work) and `keepalive: true`. Returns the response
  status so the UI can confirm — feedback is *not* fire-and-forget like error
  beacons; the user is waiting and deserves a success state.
- Failures return quietly; the UI shows a gentle retry. No offline queue.

**Form UI** — minimal, from the existing token/class system
([frontend-design-system.md](../frontend-design-system.md)):

- A **"Send feedback"** link/button in the today-view footer
  (`frontend/src/components/today-view.js`) opening a native `<dialog>`
  (web component `frontend/src/components/feedback-dialog.js`, mirroring how
  other components are structured) with: a single textarea, a submit button,
  a cancel/escape path (native dialog gives this), and a submitted state
  ("Thanks — your feedback went straight to the team.").
- No category picker, no email field, no rating (open question 1).

**Tests**: payload shape + cap, context attachment (page/release/id), api-base
resolution, resolve-on-status, textarea maxlength.

## Phase 3 — Terraform: metric filter + alarm

**Metric filter** on the existing api Lambda log group — copy the
`client_error_forward_failed` pair (`infra/modules/app/alarms.tf:36-66`):

```hcl
resource "aws_cloudwatch_log_metric_filter" "feedback_received" {
  name           = "${local.name_prefix}-feedback-received"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "{ $.marker = \"FeedbackReceived\" }"

  metric_transformation {
    name          = "FeedbackReceived"
    namespace     = local.error_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "feedback_received" {
  alarm_name          = "${local.name_prefix}-feedback-received"
  alarm_description   = "A user submitted app feedback - read it in CloudWatch Logs Insights (saved query 'GNP feedback')."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  metric_name         = "FeedbackReceived"
  namespace           = local.error_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}
```

Semantics of these exact knobs (worth stating in review): any 5-minute period
containing ≥ 1 feedback goes ALARM → one email lands within ~5–10 minutes of the
submission; the `ok_actions` line sends a resolution email when a period passes
with nothing, restoring the armed state. Steady feedback = at most one email per
5-minute bucket. Drop-line abuse counter mirrors `client_error_dropped`
(`alarms.tf:70-99`): `FeedbackDropped` filter + high-threshold alarm
(GreaterThanThreshold 100 over 3×300s — single drops are normal noise).

**Alarm recipients** — managed **in the AWS console, not Terraform** (settled
2026-08-31): the `gnp-<env>-alarms` SNS topic created by `alarms.tf` has an
email-protocol subscription added by hand per environment (Console → SNS →
Topics → `<name_prefix>-alarms` → Create subscription → protocol `email` →
address). Each address must click AWS's **one-time confirmation email** per
topic or notifications are silently not delivered. This keeps personal
addresses out of Terraform entirely; the `var.alarm_emails` variable is left
at its empty default.

---

## Runbook — reading feedback

### Read feedback (PostHog — the store, after Phase 5a)

PostHog → **Surveys** → "GNP app feedback" → **Results** tab: response table,
per-question charts, date/property filters. Add the **Survey Results** widget
to a dashboard for volume + recent responses at a glance. Open-text responses
also feed **Self-driving**, which clusters recurring themes into reports. To
pipe responses to Slack: survey → **Response destinations**.

### Get notified on arrival (already built by Phase 3 — verify once)

1. Metric filter `FeedbackReceived` (pattern `{ $.marker = "FeedbackReceived" }`)
   counts each feedback line into the `FeedbackReceived` metric.
2. Alarm `gnp-<env>-feedback-received` fires at ≥ 1 datapoint/300 s and emails
   the SNS topic's subscribers.
3. One-time per address: accept the SNS confirmation email ("Confirm
   subscription"), or no mail arrives. Verify in dev by submitting a test
   feedback and confirming the alarm email shows `FeedbackReceived >= 1.0`
   (then read the message itself in PostHog).

### Operational triage in CloudWatch (signals only — no feedback content)

The api log group (`/aws/lambda/gnp-<env>-api`, KMS-encrypted, 365-day
retention) intentionally carries **metadata, never message text**. Useful
saved queries:

Arrival + outcomes:

```
filter marker = "FeedbackReceived" or marker = "FeedbackLogOnly"
       or marker = "FeedbackForwardFailed" or marker = "FeedbackDropped"
| fields @timestamp, marker, page, site, release, textLength
| sort @timestamp desc
```

Forward failures (should stay empty once configured):

```
filter marker = "FeedbackForwardFailed"
| fields @timestamp, reason, error
| sort @timestamp desc
```

- `FeedbackLogOnly` lines mean the forwarder skipped egress (key absent or
  survey IDs unset — expected pre-Phase-5a and in local dev). If those appear
  in dev/prod after configuration, the env vars didn't land.
- While log-only (before 5a), the full text of a submission is **dropped at
  intake** — the metadata line records that it happened (`textLength`), but
  content was never stored. This is deliberate: CloudWatch is not a content
  store in either mode.

---

## Phase 4 — verify, save, record

1. Dev E2E: submit from the form → 204 → metadata-only `FeedbackReceived` line
   in the dev log group → alarm fires (if SNS subscribers set on dev).
2. Abuse check: POST garbage → 204 + `FeedbackDropped` count, no feedback line.
3. Save the runbook's ops query per environment; note the link in
   [dev-commands.md](../dev-commands.md).
4. Update [docs/README.md](../README.md) (this thread) + check off in
   [MVP-TODO](../inprogress/MVP-TODO.md).

## Phase 5 — PostHog Surveys destination

*(Amendment, 2026-09-01. Nothing in Phases 1–4 changes: the intake, scrubbing,
log line, alarm, and fallback all stand. This phase adds the destination leg.)*

### Why Surveys, and how it works without the SDK

PostHog **Surveys** is their product-feedback feature. The load-bearing fact
(from their [custom-surveys doc](https://posthog.com/docs/surveys/implementing-custom-surveys)):
*"at its most basic level, a survey is a collection of response events"* — their
own example is a **hardcoded feedback form** that captures a `survey sent`
event directly. We never fetch surveys, never render PostHog UI, never ship the
posthog-js SDK (the CSP invariant from the error-tracking plan holds). We
hardcode the survey + question UUIDs server-side and capture the response event
via the same `/batch/` ingest call the error forwarder already makes.

What that buys, in PostHog's UI, with zero analytics code of ours:

- **Surveys results tab** — response table, shown/dismissed counts, per-question
  charts, date/property filters.
- **Survey Results dashboard widget** — volume + conversion + recent responses.
- **Response destinations** — pipe responses to Slack/webhooks if wanted.
- **Self-driving** (the kicker) — a scout clusters open-text answers into
  recurring-theme reports ("five people complaining about the same thing
  becomes one report, not five you never read"), routed to the survey's owner.
- Responses ride the same anonymous per-browser `distinct_id` as error reports,
  so an admin's feedback and their error reports correlate in one place.

### Phase 5a — PostHog project setup (no code)

1. In **GNP dev** and **GNP prod** projects (same org as error tracking):
   create a survey — name "GNP app feedback", **API** presentation type, one
   **open text** question ("What's working? What's not?"), **Active**.
2. Record the **survey UUID** and the **question UUID** from each project.
3. (Optional) invite contributors to the PostHog org — same free-tier caveat as
   the error plan (org-wide coarse permissions).

### Phase 5b — forwarder + config (the ~40-line phase)

**`backend/src/handlers/feedback-forwarder.js`** — sibling of
`handlers/forwarder.js`, reusing `getPosthogApiKey` + log-only semantics
verbatim:

- Reads two new optional config values: `posthogFeedbackSurveyId` /
  `posthogFeedbackQuestionId` (`FEEDBACK_SURVEY_ID` / `FEEDBACK_QUESTION_ID`
  Lambda env vars — plain identifiers, not secrets; add to `AppConfig`).
- **Log-only mode:** key absent **or either survey ID unset** → skip egress,
  return `"log-only"` (the built-and-verified default until 5a lands; also the
  kill switch — unset a survey ID to revoke). Key present, IDs set → POST to
  `us.i.posthog.com/batch/` (host from `POSTHOG_HOST`):

  ```json
  {
    "api_key": "<project key from Secrets Manager>",
    "batch": [{
      "event": "survey sent",
      "distinct_id": "<the feedback's id (shared gnp:distinct-id UUID)>",
      "properties": {
        "$survey_id": "<survey UUID>",
        "$survey_response_<questionUUID>": "<the scrubbed message>",
        "app_source": "<page>",
        "site": "<site code if present>",
        "release": "<release>",
        "$process_person_profile": false
      },
      "timestamp": "<intake ISO>"
    }]
  }
  ```

- All failures → `FeedbackForwardFailed` WARN + still-204 (a tracker outage
  never creates app errors); `toIso`/timeout helpers mirrored from
  `forwarder.js`. The `FeedbackReceived` log line is emitted **regardless of
  forward outcome** — CloudWatch stays the always-on fallback store.
- **Terraform:** two Lambda env vars on the api function
  (`lambda.tf`, alongside `POSTHOG_HOST`); no new secrets/IAM — the project key
  secret + `secretsmanager:GetSecretValue` grant exist.

**Tests:** forwarder mapping snapshot (event shape above), log-only when key
absent, log-only when survey ID unset, failure → WARN + `"failed"`, handler
stays 204-throughout. Update `feedback.test.js` mock seams for the forwarder.

### Phase 5c — configure + verify

1. Deploy with survey IDs set in **dev**; submit from the form.
2. Confirm the event lands: PostHog dev project → Surveys → results tab shows
   the response (this is the 10-minute spike from research — server-side
   `survey sent` without `survey shown` renders fine; PostHog docs treat the
   response event as the source of truth).
3. Add the **Survey Results** widget to a dev dashboard; optionally a Slack
   destination.
4. Prod: repeat 5a in the prod project + set prod env vars.
5. Record: this thread's README index entry updated; MVP-TODO checked off.

### Governance & PII (Phase 5)

- **Sign-off: GRANTED (MOI, 2026-09-01)** — PostHog storage of this feedback,
  explicitly **without PII obfuscation**. Scope as recorded: submitters are
  **app administrators** (city-affiliated), and the data is **never exposed to
  non-city-affiliated staff** (no public dashboards/shares). The same
  structural mitigations apply: no contact fields collected, anonymous
  per-browser distinct IDs, `$process_person_profile: false` (no person
  profiles built in PostHog), size-capped text, allowlist-only properties.
- CloudWatch retains the full `FeedbackReceived` line as fallback; nothing is
  deleted there.

## Alternatives considered

- **DynamoDB item** (`pk = SITE#<siteId>`, `sk = FEEDBACK#<ulid>` per the
  [data model](../dynamodb-data-model.md)): nearly as cheap infra-wise, better
  long-term home (queryable, in-app views), but needs item-type decisions, an
  admin read path, and a view somewhere — real UI work this feature doesn't
  need to be useful. **Struck (settled 2026-09-01):** PostHog Surveys is the
  read/analysis plane; CloudWatch is the fallback store.
- **PostHog custom event** (feedback as a plain analytics event): workable, but
  Surveys gives the response table, charts, dashboards, Slack destinations, and
  Self-driving theme clustering for free, and the `survey sent` event is the
  documented contract for feedback. Superseded by Phase 5 (this is that
  option, done properly).
- **posthog-js SDK in the frontend with a rendered survey**: rejected again for
  the reasons the error plan rejected it — ~40 KB, `script-src`/`connect-src`
  CSP changes, ad-blocker interference, and it inverts our custody model (the
  client would hold the ingest path). Our own dialog + server-side capture is
  strictly less machinery.
- **SES email to maintainers**: no outbound email exists (the premise of this
  plan); introducing SES for this adds a verified-domain + sandbox workstream.
- **Third-party form (Google Forms/Typeform)**: zero code, but a second vendor,
  embed/CSP friction, and worse analysis than PostHog for a city app.
  Superseded by the signed-off PostHog destination.
- **CloudWatch dashboard only, no alarm**: trivially incremental later (the
  metric exists after Phase 3); an alarm was requested so feedback isn't
  discovered stale. Still the behavior when PostHog is log-only.

## PII / data classification note

The intake is **public and unauthenticated** (like `/v1/client-errors`; same
no-authorizer-for-MVP posture — `api.tf` CKV_AWS_309 note). The form **asks for
no contact info and offers no reply channel** — feedback is anonymous by design
(settled 2026-08-31: no reply feature will be built; record any demand here
only as a data point). Free-text is free-text: users may volunteer
names/phones in `text`. Stance: accepted and bounded — text is size-capped and
stored **only in PostHog Cloud (US)** under the 2026-09-01 sign-off, explicitly
**without PII obfuscation**, with scope recorded in the Amendment decisions:
administrator-submitted, never exposed to non-city-affiliated staff.
**CloudWatch does not store feedback content** — the `FeedbackReceived` line is
metadata-only (textLength, never text), in both log-only and forwarding modes,
so the log group is not a second copy of the PII surface. Mitigations that
remain structural: allowlist-only
payload, no person profiles (`$process_person_profile: false`), anonymous
shared distinct IDs, capped sizes. No NLP/PII
scrubber is attempted (false positives would corrupt real feedback).

## Amendment history

- **2026-09-01 (later) — CloudWatch no longer stores feedback content.** With
  the PostHog sign-off in hand, the original "log line as fallback store"
  behavior was removed: the `FeedbackReceived` line is metadata-only (never
  `text`) in **both** modes, so the message exists solely in PostHog from day
  one and the log group never becomes a second PII surface. The
  `FeedbackForwardFailed` filter + alarm were added (feedback arriving but not
  reaching the store is now page-worthy, since CloudWatch holds no copy).
  Trade-off recorded honestly: while log-only (pre-5a), submissions are
  counted but their text is dropped — acceptable because log-only is now a
  transient configuration state, not a long-lived store.
- **2026-09-01 — PostHog Surveys destination (Phase 5).** Original design sent
  feedback only to CloudWatch because user-content egress needed a sign-off
  that didn't exist yet. Sign-off granted for PostHog (no-PII-obfuscation,
  admin-submitted, city-staff-only visibility) → added the `survey sent`
  forwarder as Phase 5 with log-only-until-configured semantics. Research
  notes: surveys' custom-surveys doc (hardcoded-form pattern), surveys API
  (personal-key management only — not needed here), viewing-results (results
  tab, dashboard widget, `getSurveyResponse` SQL).

## Open questions for review

None — all settled: textarea-only form, no reply channel, no DynamoDB, SNS
recipients console-managed (2026-08-31); PostHog Surveys destination with
granted egress sign-off, log-only until Phase 5a survey IDs exist (2026-09-01).