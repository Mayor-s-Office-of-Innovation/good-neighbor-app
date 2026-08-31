# Plan: user feedback → CloudWatch (log-based intake, no new infrastructure)

Status: **proposed** — not started.
Date: 2026-08-31

**In one sentence:** a tiny in-app feedback form posts to our own API route; the
api Lambda scrubs it and emits **one structured JSON log line** (`FeedbackReceived`
marker) to the existing api Lambda log group — that log line **is** the feedback
store, read with a saved Logs Insights query and mirrored into an SNS email via a
metric-filter alarm. No new AWS services, no datastore changes, no egress.

**Decisions (settled 2026-08-31):** the form is **textarea-only** (no category
picker, no rating); **no reply channel** — feedback is anonymous, no contact
fields; **no DynamoDB migration** — CloudWatch Logs with 365-day retention is
the permanent store (the Phase-2 item idea below is struck, not deferred);
SNS recipients are **managed in the AWS console** per environment, not in
Terraform (nothing here subscribes addresses; the existing empty-default topic
just sits ready).

## The decision

We want residents/staff to send feedback about the app. Constraints that shaped this:

- **No outbound email yet** — so no "email us the form" path, and no SES.
- **No new infrastructure** — the MVP bar for this feature is "one route, one
  handler, one alarm," all riding resources that already exist.
- **Feedback is user content**, so anything that egresses it to a third party
  (PostHog, a form vendor) re-opens the MOI/COIT egress question. Keeping it in
  CloudWatch (KMS-encrypted, access via existing IAM, 365-day retention —
  `infra/modules/app/lambda.tf:17-22`) avoids that entirely.

This is deliberately the same architecture as the client-error intake
([client-error-tracking-plan.md](./client-error-tracking-plan.md)) minus the
forwarder leg: validate → scrub → structured log. When feedback eventually
deserves a real home (in-app admin view, analytics), the Phase-2 DynamoDB item
path below is the migration — the payload contract is designed to survive it.

```
Browser  (feedback form: textarea + auto-attached context)
  │  POST /v1/feedback                      (same-origin, CSP unchanged)
  ▼
api Lambda  (validate + scrub + size-cap; never signal validity to abusers)
  │  console.log one JSON line: marker "FeedbackReceived" + scrubbed fields
  ▼
CloudWatch Logs  (/aws/lambda/gnp-<env>-api)
  ├── Logs Insights saved query          ← humans read feedback here
  └── metric filter → alarm → SNS email  ← we get pinged on arrival
```

## Scope

| Phase | What | Status |
|-------|------|--------|
| 1 | Backend: route (3 places), intake handler + scrubber, tests, WAF rate rule | In this plan |
| 2 | Frontend: `feedback.js` service + minimal form UI (today view), tests | In this plan |
| 3 | Terraform: `FeedbackReceived` metric filter + SNS email alarm (+ abuse counter) | In this plan |
| 4 | Verify E2E in dev, saved-query bookmark, docs index + MVP-TODO updates | In this plan |
| — | Phase-2 migration to a DynamoDB item | **Struck (2026-08-31)** — CloudWatch is the permanent store; see Decisions |

Out of scope (explicitly): contact-info / reply-to fields (settled — none, see
Decisions), feedback *categories* or star ratings (settled — textarea only),
an admin UI for reading feedback, offline queueing of feedback (contradicts the
deferred-offline decision in ADR 0005 / AGENTS.md — a lost offline feedback is
an acceptable loss), and any third-party intake.

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
3. Valid: `console.log` **one compact JSON line** (single `console.log` call so
   it is always one line):

   ```json
   {"level":"info","marker":"FeedbackReceived","ts":"<intake ISO>","page":"/today",
    "site":"M0101","release":"abc1234","id":"<uuid>","userAgent":"<from headers>",
    "textLength":183,"text":"<the capped feedback message>"}
   ```

   The full message **must** be in the log line — it is the store. `textLength`
   lets Insights show size without parsing. User-agent is read server-side from
   headers (reuse the `readUserAgent` helper idea from
   `handlers/client-errors.js:55-72`; consider lifting it to a shared lib).
4. Invalid payloads get a quiet-but-counted drop line (`marker: "FeedbackDropped"`,
   `logServerError`'s structured style, mirroring `DROPPED_MARKER`) so the
   metric filter has an abuse signal — silent drops would hide exactly what we
   alarm on.
5. **Always respond 204**, never signal validity to a possible abuser.

Local dev: the `local-api.mjs` route logs the same line to the dev terminal;
no mock infra needed. `.env` needs nothing — no keys, no secrets.

**Tests** (Vitest, dependency-free per repo convention): handler validation
table-tests (missing/empty/too-long message → 204 + `FeedbackDropped` line),
scrubber cases (allowlist-only output, `page` query-strip, `site` pattern
rejects, non-string coercion), happy path emits exactly one
`FeedbackReceived` line with the message intact, always-204 property.

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

## Runbook — reading feedback in CloudWatch

Everything below is zero-setup once Phase 3 ships; steps are for the AWS
console (contributors with AWS access) or CLI.

### View only feedback (Logs Insights, saved query)

Console → CloudWatch → **Logs → Logs Insights** → select log group
`/aws/lambda/gnp-<env>-api` (dev: `-dev`, prod: `-prod`; log groups are
KMS-encrypted, 365-day retention) → run:

```
filter marker = "FeedbackReceived"
| fields @timestamp, page, site, release, text
| sort @timestamp desc
```

- The `filter marker = "FeedbackReceived"` line is what excludes all other log
  noise; `text` is the feedback message itself.
- Time-range picker defaults to last 30 min — widen it (e.g. 1 week) to catch
  everything since the last review.
- **Save the query** (Queries → Save) as `GNP feedback — all`, so the next
  reader opens it in two clicks. Optional second saved query for unread-since-X
  triage: add `| filter @timestamp > <ISO>`.

CLI equivalent (no console):

```sh
aws logs start-query \
  --log-group-name /aws/lambda/gnp-prod-api \
  --start "$(date -v-7d +%s)" --end "$(date +%s)" \
  --query-string 'filter marker = "FeedbackReceived" | fields @timestamp, page, site, release, text | sort @timestamp desc'
# then: aws logs get-query-results --query-id <id from start-query>
```

### Get notified on arrival (already built by Phase 3 — verify once)

1. Metric filter `FeedbackReceived` (pattern `{ $.marker = "FeedbackReceived" }`)
   counts each feedback line into the `FeedbackReceived` metric.
2. Alarm `gnp-<env>-feedback-received` fires at ≥ 1 datapoint/300 s and emails
   the SNS topic's subscribers (`var.alarm_emails`).
3. One-time per address: accept the SNS confirmation email ("Confirm
   subscription"), or no mail arrives. Verify in dev by submitting a test
   feedback and confirming (a) the query above returns the line and (b) the
   alarm email shows `FeedbackReceived >= 1.0`.

### Retention & what's in there

Lines live in the existing api log group: KMS-encrypted, **365-day retention**
(`lambda.tf`), access governed by existing log-read IAM. Besides the feedback
line, each API-Gateway request also lands in the gateway access log — count
volume cross-checks from `$.marker` totals there are possible but unnecessary.

---

## Phase 4 — verify, save, record

1. Dev E2E: submit from the form → 204 → `FeedbackReceived` line in the dev log
   group → alarm fires (if `alarm_emails` set on dev) → saved query returns it.
2. Abuse check: POST garbage → 204 + `FeedbackDropped` count, no feedback line.
3. Save the Logs Insights query per environment; note the link in
   [dev-commands.md](../dev-commands.md).
4. Update [docs/README.md](../README.md) (this thread) + check off in
   [MVP-TODO](../inprogress/MVP-TODO.md).

## Alternatives considered

- **DynamoDB item** (`pk = SITE#<siteId>`, `sk = FEEDBACK#<ulid>` per the
  [data model](../dynamodb-data-model.md)): nearly as cheap infra-wise, better
  long-term home (queryable, in-app views), but needs item-type decisions, an
  admin read path, and a view somewhere — real UI work this feature doesn't
  need to be useful. **Struck as a follow-up (settled 2026-08-31):** the log
  line is the permanent store; only reopen if a real consumer (in-app surface,
  export) ever demands it.
- **PostHog custom event** (feedback as analytics): one more field on the
  existing forwarder... but feedback is *user content*, so it rides the
  egress sign-off boundary on a payload type it wasn't granted for. Declined.
- **SES email to maintainers**: no outbound email exists (the premise of this
  plan); introducing SES for this adds a verified-domain + sandbox workstream.
- **Third-party form (Google Forms/Typeform)**: zero code, but third-party
  egress of resident-generated content, embed/CSP friction, and a data-handling
  thread for a city app. Declined for the same reason as the PostHog option.
- **CloudWatch dashboard only, no alarm**: trivially incremental later (the
  metric exists after Phase 3); an alarm was requested so feedback isn't
  discovered stale, and the alarm IS the dashboard at this volume.

## PII / data classification note

The intake is **public and unauthenticated** (like `/v1/client-errors`; same
no-authorizer-for-MVP posture — `api.tf` CKV_AWS_309 note). The form **asks for
no contact info and offers no reply channel** — feedback is anonymous by design
(settled 2026-08-31: no reply feature will be built; record any demand here
only as a data point). Free-text is free-text: users may volunteer
names/phones in `text`. Stance: accepted and bounded — text is size-capped,
stored only in the KMS-encrypted 365-day log group under the app's existing
`DataClassification` tagging, readable only by existing log-read IAM principals,
never egressed, and deleted implicitly by log-group retention. Scrubbing here is
structural (allowlist-only payload) rather than content-rewriting; no NLP/PII
scrubber is attempted (false positives would corrupt real feedback).

## Open questions for review

None — all settled 2026-08-31 (Decisions above): textarea-only form, no reply
channel, no DynamoDB migration, SNS recipients console-managed.