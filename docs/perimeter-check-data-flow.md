# Perimeter Check Data Flow — from tap to task

*Core reference · [index](./README.md) · item shapes: [dynamodb-data-model.md](./dynamodb-data-model.md)*

**Last reviewed:** 2026-10-28 against the current handlers and storage helpers

This doc walks one typical perimeter check end-to-end: what the user does, what the app
sends to the Street Conditions analyzer and what comes back, what lands in DynamoDB at
each moment, and how the analysis data becomes the cards the user sees and resolves.
The analyzer itself is a black box here — see the [architecture doc](./architecture.md)
for its container context and [security-review.md](./security-review.md) for the media
boundaries. All sample data is realistic; every record below was traced to the code that
writes it.

---

## 1. Orientation — the shape of the whole thing

One continuous per-item pipeline, with a background scorecard fold at the end:

1. **Capture & analyze & guide — per item.** The staff member walks the perimeter adding
   photos to one flat photo roll — or, when taking photos outside isn't practical or safe,
   types one description of the whole area instead. There is no list of places to walk
   ([ADR 0014](./adr/0014-remove-places-photo-roll.md)); Finish unlocks at **one photo
   or one saved description of at least 20 characters** (frontend/src/domain/check-completion.js), a client-side
   rule the backend records but never enforces. Each piece of evidence is its
   own analysis unit: the moment it's captured it uploads to S3, registers, and the
   analyzer grades it asynchronously while the walk is still happening. As soon as the
   artifact's analysis lands, the client builds a per-item assessment from it and sends
   it to the guidance evaluator which translates issues discovered by the AI into a list
   of tasks to be performed either by the site staff or the city.
2. **Finish just ends the walk.** It flips the session to `capture-complete` and kicks off
   the background scorecard fold — a check-level grade/summary rollup written to the
   check header for analytics and compliance. No UI reads it today; the task cards keep
   working the same way on home as they did in capture.

Who's who:

- **Staff (device)** — performs the check; authenticated by an HS256 device-token JWT
  whose `siteId` claim is derived server-side, never from the body. An authorizer that
  runs but yields no claim fails closed (`MissingSiteClaimError`), never a silent
  fallback to another tenant's partition (backend/src/lib/principal.js).
- **API Lambda** — one Lambda behind all `/v1/*` routes (backend/src/lambda/api.js).
- **Analyze worker** — SQS-triggered Lambda that fetches media from S3, downscales it
  (sharp: EXIF-orient, fit 1568 px long edge, JPEG q80 — ADR 0012), and calls the
  analyzer (backend/src/workers/analyze-artifact.js).
- **Street Conditions analyzer** — external service. In: metadata (`position_descriptor`
  = "perimeter", capture time, per-photo GPS) + downscaled image bytes (`store_input:false`). Out: one
  assessment per photo — a `grade`, a one-line `general_conditions` description, and
  `identified_conditions_of_concern[]` (category/severity/explanation/evidence indices,
  plus a `user_friendly_label` per concern the cards prefer as their title).
- **DynamoDB** — single table, partition `SITE#<siteId>` (backend/src/handlers/keys.js).

---

## 2. Sequence — the happy path

```mermaid
sequenceDiagram
  autonumber
  actor Staff
  participant UI as Device (capture + home)
  participant API as API Lambda
  participant S3 as S3 media
  participant Q as SQS
  participant W as Analyze worker
  participant AZ as Analyzer (external)
  participant DB as DynamoDB

  Note over Staff,UI: /check — capture screen
  Staff->>UI: taps Add photo in the photo roll (or Describe instead → one text item)
  Note over UI: item added to session → its own pipeline starts immediately<br/>(device location is fetched best-effort, 2s cap, and rides along)
  UI->>API: POST /v1/checks (checkId as idempotency-key)<br/>once per run, lazily on the first item
  API->>DB: Put CHECK# header {status:"in_progress"}
  UI->>API: POST .../artifacts:presign {contentType, contentLength}
  API->>DB: TransactWrite parent check + quota counters + upload reservation
  API-->>UI: artifactId + presigned PUT
  UI->>S3: PUT photo bytes
  UI->>API: POST .../artifacts {artifactId, s3Key, capturedAt, latitude, longitude}
  API->>DB: Put ART# (conditional)
  API->>Q: SendMessage {s3Key…} (never bytes)
  Q->>W: deliver
  W->>S3: GetObject
  W->>W: downscale (sharp: EXIF-orient, 1568px, JPEG q80)<br/>undecodable bytes → permanent ANALYSIS# failed marker
  W->>AZ: analyze(metadata, media, store_input:false)
  AZ-->>W: assessment {grade, concerns[] incl. userFriendlyLabel}
  W->>DB: Put ANALYSIS# (conditional; success overwrites a failed marker only)
  W->>DB: bump CHECK# counters (best-effort)
  UI->>API: GET /v1/checks/{id} — poll for THIS artifact's ANALYSIS#<br/>(2s cadence, 180s cap)
  Note over UI: card shows staged progress ("Photo uploaded" →<br/>"Sent to analyzer" + elapsed timer), then flips to result cards
  UI->>API: POST /v1/assessments:evaluate<br/>(per-item envelope built from the analysis)
  API->>DB: TransactWrite ASSESSMENT# + COND# ×n + TASK# ×m<br/>(shortIds allocated from the site counter)
  Note over API,DB: eligible SF311 outbox jobs commit with task creation; worker runs them asynchronously
  Note over UI: task / condition / question cards render on the item at once
  Staff->>UI: answers "More details needed", or Edit / Delete on a card
  Staff->>UI: taps Finish check (enabled at 1 photo or 1 description)
  Note over UI: navigate home on the tap — no API call<br/>session flips to capture-complete + background fold starts
  UI->>API: POST /v1/checks/{id}/complete (background, after coverage poll)
  API->>DB: Query header + ART# + ANALYSIS# (consistent)<br/>409 analyzing until every artifact has an ANALYSIS#
  API->>DB: TransactWrite CHECK# scorecard/status + CHECK_COMPLETION# marker<br/>(marker only for perimeter checks; once-only)
  Note over UI: response is the scorecard + evidence counts — no assessment envelope exists
  Note over UI: home re-renders from listTasks → task buckets<br/>session cards hand off to backend cards as they arrive
  Staff->>UI: works task cards (Done / Call / File 311 / answers)
  UI->>API: POST /v1/tasks/{id}/complete · .../answers
  API->>DB: guarded task/condition writes
```

Reading notes:

- Steps 3–15 repeat **per evidence item**. The check header is created once (step 3),
  lazily inside the first item's analysis run; every item then runs its own
  upload→analyze→evaluate loop concurrently.
- Nothing on the wire names a place. The worker sends the analyzer the fixed
  `position_descriptor` `"perimeter"` (analyze-artifact.js `POSITION_DESCRIPTOR`); legacy
  `placeId` / `placeName` fields from a pre-Phase-2 client are accepted and ignored.
- The worker→analyzer call is the only place media leaves our stack.
- Steps 18–20 are **client-driven and background**: the backend never calls the client,
  and the scorecard fold neither mints tasks nor blocks the user — the user is working
  task cards on home while it runs.

### The branch: a failed pipeline leg

The client stamps `uploaded` on the card when the S3 PUT lands and `sent` when the
artifact is registered, with a live elapsed timer after `sent`. A failure is reduced to
a leg (`start`/`upload`/`analyze`/`evaluate`), what had already succeeded, and how long
we waited (photo-analysis.js `describeFailure`, `withLeg`). The failed card offers
**Try again** (plus **Remove** for never-uploaded photos), and retry is leg-aware
(photo-analysis.js `retryEvidenceItem`):

- a failed **analyze** leg: re-`registerArtifact` with the **same artifactId + s3Key** —
  the backend always enqueues on that path, so the worker makes a fresh analyzer call;
- a failed **upload** leg: replay the pipeline from presign;
- an interrupted run (upload done, analysis never started): adopt the persisted
  `upload.artifactId`/`s3Key` and go straight to polling.

```mermaid
sequenceDiagram
  autonumber
  actor Staff
  participant UI as Device (failed card)
  participant API as API Lambda
  participant Q as SQS
  participant W as Analyze worker

  Note over UI: card shows "Analysis didn't finish" + which leg broke<br/>+ Try again (and Remove if bytes never uploaded)
  Staff->>UI: taps Try again
  UI->>API: POST .../artifacts (SAME artifactId + s3Key — re-register)
  API->>DB: conditional ART# write (existing row still re-enqueues; 202 response)
  API->>Q: SendMessage (always on this path)
  Q->>W: deliver → worker re-runs the analyzer call
  W->>DB: Put ANALYSIS# (success overwrites a failed marker only)
  Note over UI: pipeline re-enters run() at the poll leg (idempotent-run guard)
```

### The branch: a condition needs a user answer

Some rule rows can't resolve from category+severity alone — they ask a question first
("Is this on site property?"). The condition is parked as `needs_answer`, the card renders
with Yes/No buttons, and the answer round-trip re-enters the flow:

```mermaid
sequenceDiagram
  autonumber
  actor Staff
  participant UI as Device (card buttons)
  participant API as API Lambda
  participant DB as DynamoDB

  Note over UI: card shows "More details needed" + question + Yes/No
  Staff->>UI: taps an answer (e.g. "No")
  UI->>API: POST /v1/assessments/{id}/conditions/{cid}/answers {answers:{onsite:false}}
  API->>DB: Get assessment + condition (consistent, 3-attempt retry loop)
  API->>DB: re-evaluate rule with merged answers
  API->>DB: TransactWrite: ASSESSMENT# (revision-guarded) + COND# (status=needs_answer-guarded) + TASK# (new, shortId allocated)
  API-->>UI: 200 {assessmentItem, conditionItem, taskItem}
  UI->>UI: replace condition in session → card flips to task card
```

Double-taps and retries are safe: a lost race returns 409, and if the stored answers
already match what was submitted the backend returns the stored result (200) instead of
erroring (guidance.js `recoverAnsweredCondition`). If the assessment was replaced
meanwhile (`supersededByAssessmentId`), the write fails with 409
`AssessmentRevisionConflict` and the client re-reads the latest published guidance
before proceeding.

---

## 3. Worked example — "Graffiti on the roll-up door"

Follow one realistic run through every write. Site **Civic Center Annex** (`siteId:
site-civic-01`, short codes `providerShortCode:"MOI"` / `siteShortCode:"CCA"`). Staff
walk the perimeter and take **five photos** into the photo roll; four analyze "Good" with
no concerns, and the third — the loading-dock roll-up door — comes back with graffiti.
UUID checkId minted client-side (abbreviated in this example): `0d6d1a4e…`; that photo's artifact uuid below is
abbreviated `<uuid>`. Analyzer returns for it: `{grade:"Poor", concerns:[{category:"Graffiti", severity:2, description:"Spray paint on the roll-up door", …}]}`.
Every artifact of the run is one entry in the session's flat `items[]`
(check-session.js `addItem`), keyed by its item id alone.

### Per-item capture & analyze (all during the walk)

**User taps Add photo.** The photo is added to the local session and its pipeline starts
at once (frontend/src/components/perimeter-check.js `_addPhoto` →
frontend/src/services/photo-analysis.js `analyzeEvidenceItem` → `run`). The title can recommend three photos, while Finish becomes available after one
photo or a qualifying description
(check-completion.js `completionStatus`). No DB write yet — the first `createCheck`
happens lazily inside the item's own analysis run (photo-analysis.js `ensureRemoteCheck`).

**Describe instead** is the same pipeline with a text item. `/check/describe` saves one
description per check (at least 20 characters, check-completion.js
`MIN_DESCRIPTION_LENGTH`), files it as a `kind:"text"` session item and analyzes it like
a photo (describe-instead.js `_onContinue`); reopening the screen edits the saved text,
and saving a change replaces the session item.

| API call | DB write | Record (abbreviated) |
|---|---|---|
| `POST /v1/checks` (once; idempotency-key = UUID) | Put CHECK# | `pk SITE#site-civic-01` · `sk CHECK#0d6d1a4e…` · `{status:"in_progress", startedAt, issueCount:0, maxSeverity:0}` (the body may set `flowType`; a legacy `places` list is ignored) |
| `POST .../artifacts:presign` | TransactWrite | Checks parent existence/status, reserves check/device daily quota, and writes a one-day `UPLOAD_RESERVATION#<checkId>#<artifactId>` before returning the artifact ID and S3 key `checks/site-civic-01/0d6d1a4e…/<uuid>` |
| (device PUTs bytes straight to S3) | — | — |
| `POST .../artifacts` (register) | Put ART# (conditional) | `sk CHECK#0d6d1a4e…#ART#<uuid>` · `{s3Key, capturedAt, latitude, longitude, contentType:"image/jpeg"}` → then SQS send `{siteId, checkId, artifactId, s3Key, capturedAt…}` (never bytes) |
| *(SQS → worker → analyzer)* | Put ANALYSIS# (conditional) | `sk CHECK#0d6d1a4e…#ANALYSIS#<uuid>` · `{status:"analyzed", grade:"Poor", gradeDescription:"…", concerns:[{category:"Graffiti", rating:2, explanation:"Spray paint…", userFriendlyLabel:"Graffiti", evidenceIndices:[0]}], issueCount:1, maxSeverity:2, analysisId, rubricVersion, model, latitude, longitude}` + best-effort header counter bump |
| *(the other four photos)* same three calls each | Put ART# + ANALYSIS# ×4 | same shapes; each analyzed "Good" with `concerns:[]`, `issueCount:0` |
| *(alternative: Describe instead)* `POST .../artifacts` (text: no s3Key, carries `text`) | Put ART# + ANALYSIS# | `sk CHECK#0d6d1a4e…#ART#<uuid>` · `{text:"Sidewalk and loading dock are clear, no dumping or graffiti today.", capturedAt, latitude, longitude}`; the worker sends it as `{type:"text"}` media with the same `position_descriptor`. One description satisfies the completion rule on its own |

While that runs, the card shows staged progress — "Photo uploaded" → "Sent to analyzer"
with an elapsed timer (analysis-results.templates.js `pendingCard`) — and flips to
result cards when `GET /v1/checks/{id}` returns the ANALYSIS# item
(photo-analysis.js `waitForArtifactAnalysis`).

Removing registered evidence through `removeEvidenceItem` calls the artifact delete
route before dropping the local item. The route refuses deletion after check
completion, removes the ART row, and leaves analysis history and S3 lifecycle
cleanup separate. Remaining ART rows determine completion coverage and evidence
counts. Do not infer physical S3 deletion from deletion of the ART record.

**Guidance mints for that item right away.** The client builds a per-item assessment
from the analysis (photo-analysis.js `assessmentFromAnalysis` — the ids are
*per artifact*, not per check: `assessmentId = checkId-artifactId`,
`conditionId = artifactId-001-graffiti`) and calls `assessments:evaluate` with it
(photo-analysis.js `guidanceFromAnalysis` → `evaluateAssessment`):

| API call | DB write | Record (abbreviated) |
|---|---|---|
| `POST /v1/assessments:evaluate` | TransactWrite | see below |
| ↳ assessment | Put ASSESSMENT# (conditional) | `sk ASSESSMENT#0d6d1a4e…-<uuid>` · `{status:"tasks_created", policyVersion:"actions-escalations-v3", grade:"Poor", assessmentRevision:0, summary:{totalConditions:1, conditionsResolvedToTasks:1, openTaskCount:1, escalationCount:1, …}}` |
| ↳ condition | Put COND# (conditional) | `sk ASSESSMENT#0d6d1a4e…-<uuid>#COND#<uuid>-001-graffiti` · `{status:"tasks_created", analyzerCategory:"Graffiti", canonicalCategory:"Graffiti", severity:2, userFriendlyLabel:"Graffiti", source:{latitude, longitude, positionDescriptor:"perimeter"}, answers:{onsite:false}, taskIds:[<taskId>], resolvedToTasks:true, selectedRuleId:"GRAFFITI-2", needsAnswer:null}` (+ GSI4/GSI5 stamps) |
| ↳ task | Put TASK# (conditional) | `sk TASK#<uuid>` · `{shortId:"MOI-CCA-001", status:"open", kind:"escalation", type:"city_escalation", ruleId:"GRAFFITI-2", policyVersion, category:"Graffiti", userFriendlyLabel:"Graffiti", severity:2, label:"Ask the City to clean the graffiti.", guidance:"If the graffiti is not on your property…", appActions:[create_311_ticket…], conditionId, assessmentId, checkId, sourceArtifactIds:[<uuid>]}` (+ GSI1 task timeline and GSI2 worklist stamps) |

The task's **shortId** is minted before the transaction: the store reads the site's
short codes off `#META`, then atomically bumps the site's
`COUNTER#task-display-id` counter (`nextTaskDisplayNumber`) and formats
`<providerShortCode>-<siteShortCode>-<nnn>` (guidance-store.js
`allocateTaskShortIds`). `taskId` stays the canonical identifier; the shortId is the
human-facing reference the cards display (today-view.js `displayTaskId`).

The example's task assumes the user answered `onsite: false`. The current
`actions-escalations-v3` GRAFFITI-2 rule requires that answer; the initial evaluation
can first store a `needs_answer` condition. The answer transaction then creates the
task. It is not an implicit default to City responsibility.

**Automatic app actions use a transactional outbox.** Applicable informational
311 jobs (`executionTrigger: "task_created"`) commit with task creation as
`SF311_JOB#<taskId>#created` rows. Streams dispatches them to the background worker;
`SF311_LOCK#<taskId>` retains the worker lease and integration checkpoints. The worker
merges results into the task without delaying the evaluation response. User-confirmed
filing uses its separate tap-triggered job when async filing is enabled. See
[architecture](architecture.md#guidance-workflow-rule-driven-tasks).

The four "Good, no concerns" photos still **write no ASSESSMENT#/COND#/TASK#
records** — their assessment envelopes carry zero conditions, so nothing mints
(assessmentFromAnalysis filters concerns to `rating > 0`, and a no-issue item stores its
analysis locally only).

### Finish — background scorecard fold

**User taps Finish check** — enabled once the roll holds one photo or one qualifying description
(check-completion.js `isPerimeterCheckComplete`); the backend never refuses a completion
on evidence grounds. No API call on the tap: capture ends, the session flips to
`capture-complete` (check-session.js `markCaptureComplete`, draft cleared) and
`finalizeCaptureScorecardInBackground` (submit-check.js) starts; the user lands on home
(perimeter-check.js `_finishCheck` → `navigate("/today")`).

| API call | DB write | Record (abbreviated) |
|---|---|---|
| `POST /v1/checks/{id}/complete` | TransactWrite CHECK# update (guarded: `#status <> "completed"`) + perimeter CHECK_COMPLETION# marker | `{status:"completed", grade:"Poor", summary:"<analyzer's own line for the worst artifact>", categories:[{category:"Graffiti", maxRating:2, sourceArtifactIds:[<uuid>]}], rubricVersion, issueCount:1, maxSeverity:2, photoCount:5, textCount:0, evidenceKind:"photos", synthesizedAt, completedAt}` — four "Good" photos lost to the door's "Poor" (worst-of synthesis, backend/src/analysis/synthesize-check.js). The evidence mix is counted from the ART# items (checks.js `evidenceSummary`: `photos` / `description` / `mixed` / `none`). No guidance envelope in the request or response. |

The endpoint is coverage-gated: it re-reads the header + all children consistently and
returns `409 analyzing` until **every registered artifact has an ANALYSIS# item**
(failed markers count toward coverage but carry no concerns). The completion write is
conditional on the header not already being `completed`, so a replay is an idempotent
200 (backend/src/handlers/checks.js `completeCheck`). If the app is closed before the
fold finishes, the next home load re-kicks it from the persisted `capture-complete`
session (today-view.js; re-finalizing is idempotent), and the session is cleared once a
completed header with the same id shows up in history
(today-view.js `isStalePendingSession`).

**The response is the scorecard plus the evidence counts.** Guidance is per-item at
capture time, so there is nothing for completion to evaluate. The header's `grade`/`summary`/`categories` rollup and
`photoCount`/`textCount`/`evidenceKind` are written once for reporting. Manager check
reports expose compact per-check photo counts; lake analytics reads the exported
header. The completion marker supports strongly consistent capture guidance. `evidenceKind` is what lets the compliance report show how
often staff use the text path instead of photos.

### While on home — cards, answers, amendments

Home renders three sources together: backend task cards (`GET /v1/tasks?status=…`,
GSI2, handlers/tasks.js), the session's live analysis cards until backend cards exist for
the same problem, and a "That's a wrap" summary when a recent run resolved without new
issues (the dedup and the wrap logic both live in today-view.js `_homeResults`; § 4
covers the gating).

- **Question cards.** A condition with `needsAnswer` renders as **"More details needed"**
  with the prompt and Yes/No buttons
  (analysis-results.templates.js `conditionEvidenceCard`/`clarifyingQuestion`). Say the
  Dock photo had found **"Animals"** severity 2 instead (rules ANIMAL-1/2
  require *"Is this animal owned by a site client or resident?"* before they resolve):

| API call | DB write | Record (abbreviated) |
|---|---|---|
| `assessments:evaluate` (at capture) | Put COND# | `sk ASSESSMENT#…#COND#<uuid>-001-aggressive-animals` · `{status:"needs_answer", needsAnswer:{key:"affiliated", prompt:"Is this animal owned by a site client or resident?", options:[{label:"Yes", value:true},{label:"No", value:false}]}, answers:{}, taskIds:[]}` (+ GSI5 unresolved stamp) |
| `POST /v1/assessments/{id}/conditions/{cid}/answers {answers:{affiliated:false}}` **(user taps "No" on the card)** | TransactWrite | same COND# now `{status:"tasks_created", answers:{affiliated:false}, taskIds:[<newTaskId>], resolvedToTasks:true, needsAnswer:null, selectedRuleId:"ANIMAL-2", outcome:{kind:"non_actionable_escalation", …}}` — GSI5 stamp removed; new TASK# `{shortId:"MOI-CCA-002", kind:"non_actionable_escalation", ruleId:"ANIMAL-2", …}` minted; assessment summary deltas applied (conditionsNeedAnswer −1, openTaskCount +1) in the same transaction, guarded by `assessmentRevision` and `attribute_not_exists(supersededByAssessmentId)` |

  Answering replaces the condition in the client session
  (photo-analysis.js `answerAnalysisQuestion`), so the card re-renders as the task card
  for the same conditionId. If the answer races a concurrent refresh
  (`AssessmentRevisionConflict`), the client re-reads the latest published guidance and
  re-renders from that.

- **Edit / Delete on a card** are the amendments endpoints
  (backend/src/handlers/analysis-amendments.js); both publish guidance through the
  **lineage refresh** (below). Edit re-runs the analyzer on an amended description and
  the result publishes as a new assessment revision. Delete (reason `not_a_problem`)
  rejects the analyzer condition, then retires its open tasks; a 404
  `unknown_condition` from the analyzer counts as already-rejected so a task that
  outlived its condition is still retired, and the card's `taskId` narrows retirement to
  that task (guidance-store.js `supersedeOpenTasksForCondition`). A task that
  transitioned mid-deletion counts as retired, not an error. On the client the card
  disappears behind a cancellable "Item deleted" toast with Undo
  (state/pending-deletions.js, analysis-card-deletion.js), so worklist cards without a
  local session still get durable deletions.

### Guidance lineage — how a refresh replaces an assessment

An amendment (or any re-evaluation that changes an item's conditions) publishes a
**successor assessment** in one transaction (guidance-store.js
`storeEvaluatedAssessment`):

| Write | Record |
|---|---|
| Put ASSESSMENT# | the new revision, `assessmentRevision` inherited + 1, `rawAssessment` from the refreshed analyzer output |
| Put/retain COND# | conditions whose identity (explicit conditionId, policy/category/severity/label/description, artifact set) is unchanged are **preserved with their answers and open tasks**; changed/new ones re-evaluate and may mint tasks |
| Put TASK# | new tasks for new outcomes (shortIds from the same site counter) |
| Put `GUIDANCE_CURRENT#` pointer | `sk GUIDANCE_CURRENT#<JSON [checkId, lineageId]>` → `{assessmentId: <new>}`, conditioned on still pointing at the predecessor |
| Update predecessor ASSESSMENT# | `SET supersededByAssessmentId, lineageId`, guarded by `assessmentRevision` — closes the race with concurrent answers |
| Put retired TASK# | open tasks of removed/changed conditions → `status:"superseded"`, `supersessionReason:"assessment_refreshed"`, guarded `#status = :open` |

`lineageId` is the artifact ID (artifact-less API assessments use their original
assessment ID), so an item's whole guidance history is one pointer. A completing task
blocks publication until it settles (`TaskTransitionConflict` → 409) — completed tasks
remain historical records, never undone by a refresh. Historical reads resolve through
the pointer (`getPublishedAssessmentGuidance`), so an old assessmentId in a URL or an
idempotent retry lands on the current revision. The client drives this with
`previousAssessmentId` and a 409-retry loop that adopts whichever revision won
(photo-analysis.js `refreshEvidenceAnalysis`).

### Dismissal & completion — task cards on home

Task state depends on the recorded rule and the selected action, not just the
presence of a ticket. Eligible rules snapshot `canBeInProgress: true`; a successful
first action leaves those tasks `in_progress`. Other rules can complete directly.
With async filing enabled, a 311 tap atomically sets `in_progress`/`queued` and
writes `SF311_JOB#<taskId>#filed-<id>`. The worker files and records the result;
failed filings retain retryable or reconciliation state rather than claiming success.
The compatibility in-request path uses a conditional completion lease.

Explicit `issue_resolved` updates atomically write a completed task and timeline
event/pointer, plus a background closure job when applicable. Automatic 311 closure
does not block or undo that resolution. Update photos use separate TASK MEDIA rows
and CHECK UPDATE_MEDIA pointers, never ART rows or analyzer work. See the
[data model](dynamodb-data-model.md#extra-task-fields) and
[interrupted-action recovery runbook](runbooks/recovery.md#issue-updates-after-an-interrupted-311-filing).

### Final database state (the whole run)

| pk | sk | Key attributes (end state) |
|---|---|---|
| `SITE#site-civic-01` | `#META` | site config incl. `providerShortCode:"MOI"`, `siteShortCode:"CCA"`, and the admin-geocoded `location` (Census geocoder; 311's fallback when a photo carried no GPS) |
| `SITE#site-civic-01` | `COUNTER#task-display-id` | `nextTaskDisplayNumber:2` (one number allocated per minted task; gaps allowed) |
| `SITE#site-civic-01` | `CHECK#0d6d1a4e…` | status `completed`, grade `Poor`, summary + categories rollup, issueCount 1, maxSeverity 2, photoCount 5, textCount 0, evidenceKind `photos` |
| `SITE#site-civic-01` | `CHECK_COMPLETION#<Pacific date>#<completedAt>#<checkId>` | immutable completion marker for capture guidance |
| `SITE#site-civic-01` | `CHECK#0d6d1a4e…#ART#<uuid>` ×5 | s3Key, capturedAt, latitude/longitude, contentType (photo metadata; bytes in S3). A Describe-instead run holds one such row carrying `text` and no s3Key |
| `SITE#site-civic-01` | `CHECK#0d6d1a4e…#ANALYSIS#<uuid>` ×5 | raw adapted analyzer output: grade + concerns[] per artifact |
| `SITE#site-civic-01` | `GUIDANCE_CURRENT#<JSON [0d6d1a4e…, <uuid>]>` | pointer to the current assessment for the artifact's lineage (`assessmentId`) |
| `SITE#site-civic-01` | `ASSESSMENT#0d6d1a4e…-<uuid>` | status `tasks_created`, summary counts, rawAssessment (per analyzed artifact that had concerns) |
| `SITE#site-civic-01` | `ASSESSMENT#0d6d1a4e…-<uuid>#COND#<uuid>-001-graffiti` | status `tasks_created`, taskIds, selectedRuleId `GRAFFITI-2`, answers {onsite:false} |
| `SITE#site-civic-01` | `TASK#<uuid>` | status `completed`, `shortId:"MOI-CCA-001"`, kind `escalation`, ruleId `GRAFFITI-2`, appActionResults |

Every check-scoped item shares one `pk`, so the check-detail read (AP7) is a paginated
`begins_with(sk, "CHECK#0d6d1a4e…")` query pattern. The completion marker has its
own prefix and is read separately. Guidance items (ASSESSMENT#/COND#/TASK#) key
off the per-artifact assessment id, and the `GUIDANCE_CURRENT#` pointer ties them to the
item's lineage, so an amendment can supersede one condition's tasks without touching
siblings. See the data-model doc's "Guidance refresh lineage" section for item shapes.

---

## 4. The gates — how data decides what the user sees

Nothing in the UI is toggled by side-flags; cards render from stored/derived state. The
gates, in order:

**a. Session stage machine (during/after capture).** The local session carries a status
that the home view keys off (check-session.js `markCaptureComplete`):

```mermaid
stateDiagram-v2
  [*] --> in_progress: start check
  in_progress --> capture_complete: Finish tap (no API call) → home
  capture_complete --> [*]: completed header lands in history → stale-clear
```

- `in-progress` → capture region open on home. `capture-complete` → home shows the
  captured items' analysis cards; the background scorecard fold runs from here (and is
  re-kicked on every home load until the completed header appears).

**b. Card selection per evidence item** (analysis-results.templates.js
`visibleProblemSelection`):

```mermaid
flowchart TD
  A[item analysis status] -->|failed| B[failed card: leg + Try again / Remove]
  A -->|queued / analyzing| C[pending card: staged progress<br/>+ elapsed timer]
  A -->|analyzed| D{visible problems?}
  D -->|"tasks or conditions"| E[task cards, paired by conditionId<br/>+ unpaired condition cards]
  D -->|none| F[no-issue card, suppressed when hideNoIssuesCard]
  E --> G[hidden = pending deletions ∪ resolvedConditionIds ∪ rejectedConditionIds]
  F --> G
  E --> H["summary count = tasks + unpaired conditions"]
  F --> H
```

- A condition is **hidden** when its conditionId is in `resolvedConditionIds`,
  `rejectedConditionIds`, or behind an app-lifetime **pending deletion** (the
  cancellable-delete toast — `pendingDeletedConditionIds` covers stale backend reads
  until the deletion commits).
- A task card's title is `userFriendlyLabel → category → analyzerCategory →
  canonicalCategory` fallback (`displayCategory`) — the analyzer now returns a
  `user_friendly_label` per concern, and the cards prefer it (#216).
- The "N problems found" label counts **tasks + unpaired conditions** — the same units the
  tray renders, so the count never disagrees with the cards.
- Once backend task cards for the same problem exist (matched by
  taskId/conditionId/assessmentId), the session card yields so the two sources never
  duplicate (`sessionProblemItemHasBackendCards`).

**c. Question cards.** A condition with `needsAnswer` renders as "More details needed" +
prompt + Yes/No buttons. Answering updates the data in the session and DynamoDB (§ 3),
so the card disappears because the data changed. Double-tap protection: per-condition
in-flight set + button disabling client-side; `status = needs_answer` guard server-side.

**d. Home worklist buckets** (`frontend/src/domain/home-tasks.js`). `open` is
needs-action; `completing`, `resolving`, and `in_progress` display as in-progress.
A legacy `completed`/`311_filed` task can still display in-progress until its filed
ticket is closed. Resolved tasks move to history, with a 72-hour resolved/archive
display boundary; a separate 14-day creation-age rule archives expired tasks.
These are presentation rules, not DynamoDB TTL or deletion. Pending deletion and
local overrides smooth the UI while authoritative writes finish.

Phone CTAs record a site-bound task-completion receipt in tab session storage before
opening `tel:`. Returning online, restoring the page, or reloading retries an interrupted
save without dialing again; failures offer a persistent save-only retry. Calls never
wait for the backend. If browser storage is unavailable, recovery is limited to the
current page lifetime. Replaying a saved phone completion returns the existing task
without adding another update or ticket. This is limited phone-handoff recovery, not
general offline support.

**e. Condition status state machine** (what gates a condition between card types):

```mermaid
stateDiagram-v2
  [*] --> needs_answer: evaluate → question required
  [*] --> tasks_created: rule resolves immediately
  [*] --> manual_review: category unresolved / no rule matched
  [*] --> completed: no rule outcome applies
  needs_answer --> tasks_created: answer submitted + rule resolved
  needs_answer --> needs_answer: answer submitted + next question
  needs_answer --> completed: answer → no rule matched
  needs_answer --> manual_review: answer → unresolved category
```

Task status (`open → completing → in_progress | completed`, with `superseded` for retired tasks) is guarded by
conditional writes end-to-end — a replay can never double-complete or double-mint, and
the lineage publication never retires a mid-`completing` task (§ 3).

---

## 5. Where things live in code

| Step | Write site | Read/render site |
|---|---|---|
| Create check (lazy, per run) | backend/src/handlers/checks.js `createCheck` (optional flowType; no places) | frontend/src/services/photo-analysis.js `ensureRemoteCheck` |
| Completion rule (client-side only) | — | frontend/src/domain/check-completion.js `isPerimeterCheckComplete` (1 photo or 1 qualifying description); perimeter-check.js `_done` / `_finishCheck`, templates `progressLine` / `footer` |
| Describe instead (one text item per check) | backend/src/handlers/artifacts.js `registerArtifact` (text, no s3Key) | frontend/src/components/describe-instead.js `_onContinue` → photo-analysis.js `analyzeEvidenceItem` |
| Presign / register artifact | backend/src/handlers/artifacts.js `presignUpload`, `registerArtifact` (S3 key `checks/<siteId>/<checkId>/<artifactId>`; legacy place fields ignored) | frontend/src/services/api.js `uploadArtifact`, `registerTextArtifact` (photo-analysis.js `run`) |
| Device location (per item) | — | frontend/src/services/device-location.js `getCaptureDeviceLocation` (2s best-effort; 311 falls back to the site's geocoded `#META` location) |
| Per-item analysis | backend/src/workers/analyze-artifact.js (+ media/downscale.js) | frontend/src/services/photo-analysis.js `analyzeEvidenceItem` → `waitForArtifactAnalysis` |
| Failed-card retry | — | photo-analysis.js `retryEvidenceItem` (re-register same artifactId → fresh analyze) |
| Per-item guidance evaluate → tasks | backend/src/handlers/guidance.js `evaluateAssessment` → analysis/guidance/guidance-store.js `storeEvaluatedAssessment` (+ `allocateTaskShortIds`) | frontend/src/services/photo-analysis.js `guidanceFromAnalysis` |
| Card rendering | — | frontend/src/components/analysis-results.templates.js (tray on home/capture), today-view.js |
| Question round-trip | backend/src/handlers/guidance.js `submitConditionAnswers` + guidance-store.js `answerCondition` (+ `recoverAnsweredCondition`) | frontend/src/services/photo-analysis.js `answerAnalysisQuestion`, components/analysis-answer-controls.js, today-view.js `_answerAnalysisQuestion` |
| Edit / reject condition (amendments) | backend/src/handlers/analysis-amendments.js → guidance-store.js `supersedeOpenTasksForCondition` + lineage refresh `storeEvaluatedAssessment` | today-view.js `_saveProblemEdit` / `_confirmDeleteProblem`, components/analysis-card-deletion.js + state/pending-deletions.js, photo-analysis.js `refreshEvidenceAnalysis` |
| Complete / synthesize scorecard + evidence counts | backend/src/handlers/checks.js `completeCheck`, `evidenceSummary` + backend/src/analysis/synthesize-check.js | frontend/src/services/submit-check.js `finalizeCaptureScorecardInBackground` |
| Home worklist | backend/src/handlers/tasks.js `listTasks` | frontend/src/components/today-view.js (`homeTaskStatus`, evidence hydration) |
| Task completion / 311 | guidance-store.js `completeTaskWithAppActions`, task-updates.js, and workers/sf311-job.js | frontend/src/components/today-view.js `_onAction`, `_resolveAnalysisProblem` (+ state/toasts.js 311 toasts) |
| Task short IDs | guidance-store.js `allocateTaskShortIds` (counter `COUNTER#task-display-id`) | today-view.js `displayTaskId` |
| Guidance lineage | guidance-store.js `storeEvaluatedAssessment` (pointer + supersede), `getPublishedAssessmentGuidance` | photo-analysis.js `refreshEvidenceAnalysis` (previousAssessmentId + 409 reconcile) |
