# Runbook: user feedback (enable, test, read, alarm triage)

**Scope:** the in-app "Send feedback" sheet (`frontend/src/components/feedback-dialog.js`) →
`POST /v1/feedback` → api Lambda → PostHog Surveys. 

CloudWatch carries **metadata only**. While forwarding is off, submitted text is
discarded at intake because we don't want to risk recording sensitive information in 

## Current state (2026-09-02)

**Dev is enabled** (survey IDs wired in `infra/environments/dev/main.tf`; verified end-to-end
locally 2026-09-02 — events land in PostHog and render in the survey's Results tab). Still
outstanding for dev: the `phc_` key value in Secrets Manager (§2) — until it's set, the
deployed forwarder stays log-only. **Prod is log-only**: its env root has no survey IDs and
the prod PostHog project has no survey yet. Enable prod with the steps below.

## 1. Create the survey (PostHog dashboard, no code)

Per project — **GNP dev** and **GNP prod** (same org as error tracking):

1. Surveys → New survey. Name **"GNP app feedback"**, one **open-text** question
   ("What's working? What's not?"), state **Active**.
   - **Presentation type — pick "API".** If created with the default web/popover type,
     clear the recurring schedule: the default "recurring" schedule auto-creates 10 × 30-day
     iterations, and the Results tab filters responses by `$survey_iteration` — server-side
     events carry no iteration property, so they ingest fine (visible under Events) but
     **never show in Results**. Single-schedule (or API type) has no iterations → nothing
     filters them out.
2. Copy the **survey UUID** from the survey page. The **question UUID is not shown in the
   UI** — read it from the surveys API response instead:
   - DevTools → Network on the survey page → the `/api/environments/…/surveys/` request →
     response JSON → `questions[0].id`; or
   - `curl -s -H "Authorization: Bearer <personal key (phx_…)>" \
      "https://us.posthog.com/api/environments/<project_id>/surveys/" | jq
      '.results[] | {name, id, question_id: .questions[0].id}'`
     (project id = the number in the `…/project/<id>` URL; EU cloud → `eu.posthog.com`).
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

Plain identifiers, not secrets — add to `infra/environments/<env>/main.tf`'s `module "app"`
(dev is done as the reference example):

```hcl
  feedback_survey_id   = "<survey uuid>"
  feedback_question_id = "<question uuid>"
```

Then merge to `dev` (CI applies; **no laptop applies**). Unsetting either ID later is the
kill switch (forwarder returns to log-only). `POSTHOG_HOST` only needs setting for EU-cloud
projects (default `us.i.posthog.com`).

## 4. Verify in dev

1. Submit from the in-app form.
2. **PostHog → Surveys → "GNP app feedback" → Results** shows the response (server-side
   `survey sent` without `survey shown` renders fine; the response event is the source of
   truth). If Events shows `survey sent` but Results stays empty, re-read §1 step 1 — an
   iteration-scoped survey hides server-side responses.
3. CloudWatch shows `FeedbackReceived` and **no** new `FeedbackLogOnly` lines
   (`FeedbackLogOnly` after configuration = the env vars didn't land). A successful forward
   logs nothing — "silent success, noisy failure" is deliberate; don't wait for a
   forwarding confirmation line.

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
wired (`backend/scripts/local-api.mjs` → `POST /v1/feedback`). Restart the backend after
editing `.env.local` — config is read at process start. Note the local loop is *more* enabled
than a freshly-configured deployed env: locally the key comes straight from `.env.local`
(precedence in `handlers/posthog-api-key.js`), while deployed Lambda needs the §2 secret set.

### You can retrieve PostHog survey info as json when logged

```https://us.posthog.com/api/environments/<project id>/surveys/<survey id>```

The above json provides survey ids (which are also visible in the url when viewing survey info) as well as question ids which are hard to find elsewhere.

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