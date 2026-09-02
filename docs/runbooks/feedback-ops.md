# Runbook: user feedback (enable, test, read, alarm triage)

**Scope:** the in-app "Send feedback" sheet (`frontend/src/components/feedback-dialog.js`) →
`POST /v1/feedback` → api Lambda → PostHog Surveys. 

CloudWatch carries **metadata only**. While forwarding is off, submitted text is
discarded at intake because we don't want to risk recording sensitive information in 

## Current state (2026-09-02)

Forwarding is **log-only in every environment**: neither `dev` nor `prod` sets
`feedback_survey_id`/`feedback_question_id` (`infra/environments/*/main.tf`), and the
`posthog-project-api-key` secret exists as a container only (value never set —
`infra/modules/app/secrets.tf`). Users see "your note is on its way" but nothing egresses.
Enable with the steps below.

## 1. Create the survey (PostHog dashboard, no code)

Per project — **GNP dev** and **GNP prod** (same org as error tracking):

1. Surveys → New survey. Name **"GNP app feedback"**, presentation type **API**, one
   **open-text** question ("What's working? What's not?"), state **Active**.
2. Copy the **survey UUID** and the **question UUID** from the survey page.
3. (Optional) invite contributors to the org — same free-tier caveat as error tracking.

## 2. Put the project API key in Secrets Manager (per environment)

The key is the **Project API key** (`phc_…`, write-only ingest) from Project → Settings —
never a personal key. Terraform created the container only; set the value out-of-band so it
never enters state or VCS:

```sh
aws secretsmanager put-secret-value \
  --secret-id good-neighbor-app-<env>-posthog-project-api-key \
  --secret-string 'phc_…'
```

## 3. Wire the survey IDs into the environment root

Plain identifiers, not secrets — add to `infra/environments/<env>/main.tf`'s `module "app"`:

```hcl
  feedback_survey_id   = "<survey uuid>"
  feedback_question_id = "<question uuid>"
```

Then merge to `dev` (CI applies). Unsetting either ID later is the kill switch (forwarder
returns to log-only). `POSTHOG_HOST` only needs setting for EU-cloud projects (default
`us.i.posthog.com`).

## 4. Verify in dev

1. Submit from the in-app form.
2. **PostHog → Surveys → "GNP app feedback" → Results** shows the response (server-side
   `survey sent` without `survey shown` renders fine; the response event is the source of truth).
3. CloudWatch shows `FeedbackReceived` and **no** new `FeedbackLogOnly` lines
   (`FeedbackLogOnly` after configuration = the env vars didn't land).

## Local testing (no AWS)

Put all three values in **`.env.local`** (git-ignored; loaded by the `local:*` scripts
via `--env-file`). Config precedence in `backend/src/handlers/posthog-api-key.js` checks the
direct key first, so no Secrets Manager needed locally:

```
POSTHOG_PROJECT_API_KEY=phc_…
FEEDBACK_SURVEY_ID=<survey uuid>
FEEDBACK_QUESTION_ID=<question uuid>
```

Run `npm run dev -w backend` + `npm run dev -w frontend` (the Vite proxy forwards `/v1` to
`:3001`), submit from the form, and check the survey's Results tab. The local route is already
wired (`backend/scripts/local-api.mjs` → `POST /v1/feedback`).

## Reading the signals

**CloudWatch** (api log group, `/aws/lambda/gnp-<env>-api`) — metadata only:

```
filter marker = "FeedbackReceived" or marker = "FeedbackLogOnly"
       or marker = "FeedbackForwardFailed" or marker = "FeedbackDropped"
| fields @timestamp, marker, page, site, release, textLength
| sort @timestamp desc
```

- `FeedbackReceived` — valid submission (fires the arrival alarm).
- `FeedbackLogOnly` — forwarder skipped egress (expected pre-config + local dev; after
  config, means env vars didn't land — **the text was discarded**).
- `FeedbackForwardFailed` — submission arrived but never reached PostHog (pages; check the
  `reason`/`error` fields).
- `FeedbackDropped` — invalid payload (abuse signal; high-threshold alarm only).

**PostHog → Surveys → "GNP app feedback" → Results** — the actual notes. Add the Survey
Results widget to a dashboard for volume at a glance; open-text answers feed Self-driving's
theme clustering; survey → Response destinations can pipe to Slack.

**Alarm triage** (`<env>-feedback-received` pages): the note itself is in PostHog (step 4
above). If PostHog shows nothing for that time, check for `FeedbackLogOnly`/`FeedbackForwardFailed`
lines — log-only means it was discarded; forward-failed means PostHog rejected/was unreachable.