# Legacy Submit-Path Retirement Plan

**Status:** Approved for execution — decisions recorded in § 2
**Date:** 2026-09-10
**Related:** [perimeter-check-photo-analysis-plan.md](./perimeter-check-photo-analysis-plan.md) (the live flow's plan) ·
[perimeter-check-data-flow.md](./perimeter-check-data-flow.md) (needs a § 2–3 rewrite, § 7) ·
[admin-interface-simplification-plan.md](./admin-interface-simplification-plan.md) (companion; extends PR-B/C/D)

## 0. Session context (regain context fast)

- **Branch:** all of this work lives on `docs/dataflow` (branch tip: the dev-merge
  `5a95342` + `c294310` "docs for data flow" carrying both docs and the data-flow doc's
  § 2–3 still describing the legacy flow until PR-D).
- **Origin:** the retirement plan came out of writing
  [perimeter-check-data-flow.md](./perimeter-check-data-flow.md) — mapping the flow
  surfaced the two-pipelines finding. The dead-code verdicts were then exhaustively
  verified (grep sweeps over all of `frontend/src`, `backend/src`, `infra`, dev scripts).
- **Product decisions were given by the plan owner** (disputes gone, max deletion, no
  IndexedDB transition window, delete description-validation incl. Terraform, dev
  DynamoDB data disposable). They are recorded in § 2 — do not re-litigate.
- **Cross-references:** the data-flow doc's dispute section (§ 3 "dispute branch") and
  the Continue-minting narrative become wrong the moment PR-B/A execute — PR-D fixes
  them. The #192 review notes in `~/dev/notes/good-neighbor/`
  (`pr-review-192-home-screen-updates.md`) independently confirmed the dead-path
  finding and contain the per-item live-flow trace.
- **Known stale doc references to this plan:** none yet in repo docs; the
  `perimeter-check-data-flow.md` correction is PR-D's first item.

## 1. Context — two pipelines shipped, one is live

PR #192 (feature/192-home-screen-updates) rebuilt capture so each photo/typed description
is uploaded, analyzed, and turned into guidance **immediately at capture**
(`photo-analysis.js` `analyzeEvidenceItem` → `evaluateAssessment` per item), with Done
finalizing the run scorecard in the background (`finalizeCaptureScorecardInBackground`).

The pre-#192 batch pipeline — capture → `/review` (check-review) → `submitCheck()`
(create → bulk upload → poll → complete → `markSubmitted`) → home "Review assessment"
tile → `/results` (check-results) disputes → Continue mints tasks — **still ships but is
unreachable from the UI**. Verified below. This plan retires it.

Net effect of execution: ~2,300–2,600 lines deleted, ~100–200 added (branch collapses,
test edits, doc rewrites). No new behavior.

## 2. Verified dead-code table + recorded decisions

Full sweep verified 2026-09-10; every claim traced to call sites.

| Item | Verdict | Evidence |
|---|---|---|
| `/review` route | Dead | `app-root.js:22` + `main.js:68` are its only references; zero `navigate("/review")` / `href="/review"` |
| `check-review.js` | Dead | Renders only at `/review`; sole unique behavior is `submitCheck` (:164) |
| `check-results.js` (`/results`) | Dead | `navigate("/results")` fires only from `#review-assessment` (today-view.js:708), which renders only in the `submitted` tile branch (:1116) — a status only the legacy path sets |
| `submitCheck` + batch pipeline | Dead | Only caller is check-review; `runSubmittedCheck` (:447), `plannedArtifactsForCheck` (:239), signature dedup (:226–352), `registerUploadedArtifact` (:408) exist only for it |
| `markUploading` / `markAnalyzing` | Legacy-only | Only submit-check calls them (:574, :486); live flow parks at `capture-complete` (`markCaptureComplete`) |
| `markSubmitted` / `markAnalysisFailed` | Legacy-only | submit-check.js:188, :432/:532/:539/:579 are the only callers |
| Home `submitted` / `analysis_failed` / `uploading` tile branches | Legacy-only | today-view.js:1116, :1157, :1195 — reachable only with statuses the live flow never sets |
| `enqueueUpload` / `resumePendingUploads` | Dead | Zero callers outside artifact-uploader + tests; removed from perimeter-check in `abf83bd` (#136). Only `settlePendingUploads` is still imported (submit-check.js:33) — always resolves instantly since nothing enqueues |
| `services/image.js` (`downscaleDataUrl`) | Dead | Only artifact-uploader imports it (:28) |
| `services/analyzer.js` mock (`analyzeCheck`) | Dead | No importers. (`config/scorecard.js` `severityWord` **is live** — check-adapter.js:30) |
| `task-routing.js` (`classifyTask`) | Dead | Imported only by its own test. Comments in `adapt-scorecard.js:11` / `synthesize-check.js:8` claim it's wired into checks.js — it never was |
| check-adapter findings machinery | Dead with check-results | `headerToFindings`, `cityCategoriesByCheck`/`ForCheck`, `analysesToFindings`, `hazard` — today-view uses only `submittedAt` + staleness (today-view.js:1340: "Overall condition text is no longer used") |
| `validatePlaceDescription` (client) | Dead | No callers; validation disabled in `264d2f0` (#103) |
| `description-validation` backend stack | Dead | Client never calls it (same `264d2f0`); handler + validator + Bedrock client have no other consumers |
| Backend dispute machinery | Dead with disputes | `DISPUTE_DISPOSITIONS`/`disputedCategories`/`dispositions` parsing (guidance.js:17,53–76), `disputed`/`disputeDisposition` fields + `not_present` suppression (guidance-store.js:282–327,444–462), `disputedCount` summary, `no_tasks` status branch. Only live-path caller was the dead check-results client |
| `buildGuidanceAssessment` + envelope in `completeCheck` | Dead | Consumed only by the legacy finalize chain (submit-check.js:180–191); `finalizeCaptureScorecard` discards it (:213–219) |
| `CHECK#` header `grade`/`summary` attributes | **Write-only follow-on** | Written by `completeCheck` (live), read only by the dead check-results. Keep writing for now (cheap, compliance-valuable); re-evaluate post-retirement |
| `frontend/README.md` | Stale | Documents demo seed (dir gone), `/review` route, mocked analyzer |
| Screen-trim leftovers note (check-results "confidence %") | Stale | Current check-results.js (rewritten in #192) has no confidence code |

**Kept (verified live — do not touch):** `finalizeCaptureScorecard`(:199) +
`finalizeCaptureScorecardInBackground`(:499); `expectedArtifactCountForCheck`(:313);
`waitForAnalyses` (both finalize paths use it); `submitErrorMessage`/`SUBMIT_MESSAGES`;
amendments endpoints + `supersedeOpenTasksForCondition` (backend/src/handlers/
analysis-amendments.js → guidance-store.js); the guidance question-answer flow; the
review store + `capture-complete` stage.

### Recorded decisions

1. **Disputes are gone** — no port to the live flow. Delete all dispute code, client and
   backend. (Reviewer corrections on the live flow are served by the amendments
   endpoints: tray Edit/Delete → `editAnalysisCondition`/`rejectAnalysisCondition`.)
2. **Maximum deletion** — delete every verified-dead path, including the
   `buildGuidanceAssessment` envelope and the `disputed` status value going forward.
3. **No transition window** for legacy-stage IndexedDB sessions — delete the
   `uploading`/`analyzing`/`submitted` branches; the existing staleness logic
   (`isStalePendingSession`, today-view.js:82) + `clearSubmittedSession` already clears
   superseded records. Dev DynamoDB data is disposable; no data migration.
4. **Description-validation deleted end-to-end**, including Terraform (§ 5) — the
   validator is the backend's only Bedrock consumer (the analyzer is HTTP).

## 3. Deletion batches (each its own PR, each green on typecheck/lint/tests)

### PR-A — frontend: batch submit + dispute screens + session stages

Delete:
- `components/check-review.js`, `components/check-results.js` (+ `main.js:68-69`
  imports, `app-root.js:22-23` routes, `feedback-dialog.js:6` comment reference)
- `services/artifact-uploader.js` + `artifact-uploader.test.js`, `services/image.js`
- In `services/submit-check.js`: `submitCheck`, `runSubmittedCheck`,
  `plannedArtifactsForCheck`, `artifactSignature` + signature dedup,
  `registerUploadedArtifact`, `existingArtifactSignatures`, `finalizeSubmittedCheck`,
  `startFinalization`, `resumeSubmittedCheck`, `resumeUploadingCheck` (+ their
  `InBackground` wrappers), `markUploading/markAnalyzing/markSubmitted/markAnalysisFailed`
  imports; keep + `settlePendingUploads` import removal
  (submit-check.js:33) — the only live exports after this are
  `finalizeCaptureScorecardInBackground`, `expectedArtifactCountForCheck`,
  `submitErrorMessage` (+ internal `finalizeCaptureScorecard`)
- In `components/today-view.js`: `submitted`/`analysis_failed`/`uploading` tile branches
  (:1116, :1157, :1195–1207), `resumeSubmittedCheckInBackground`/
  `resumeUploadingCheckInBackground` usage (:625, :630) — the `capture-complete` branch
  (:621) stays as the only resume; `_assessmentTile` shrinks or goes
- In `state/check-session.js`: `markUploading`, `markAnalyzing`, `markSubmitted`,
  `markAnalysisFailed`, session `findings`/`assessment`-envelope transport semantics
  (keep `assessment` — the live question-answer flow writes/reads `assessmentId`,
  analysis-results.templates.js:385)
- In `services/api.js`: `validatePlaceDescription` (:367), envelope typing on
  `completeCheck` (:247)
- In `domain/check-adapter.js`: `headerToFindings`, `cityCategoriesByCheck`,
  `cityCategoriesForCheck`, `hazard` field, `analysesToFindings` export
  (`submit-check.js` is its only caller); slim `adaptCheckHeader` to
  id/status/submittedAt; drop today-view's `cityByCheck` plumbing (:591)
- In `services/instrument.js`-adjacent code: `submit:*` trace labels (legacy run);
  `captureScorecard:*` labels stay
- `services/analyzer.js` (mock), `analysis/task-routing.js` + its test, stale
  "task-routing.js" comments in adapt-scorecard.js:11 / synthesize-check.js:8
- Legacy `describe` blocks in `submit-check.resume.test.js` (:97–230); keep the
  `finalizeCaptureScorecard` describes (:316–375) and `submit-check.test.js`
  (`submitErrorMessage`) suites

### PR-B — backend: dispute machinery + description-validation stack

Delete:
- `handlers/description-validation.js` + test; `analysis/description-validator.js` + test
- Routes: `backend/src/lambda/api.js` (import :32 + entry :54-55),
  `backend/scripts/local-api.mjs` (:37, :125)
- Dispute machinery in `handlers/guidance.js`: `DISPUTE_DISPOSITIONS` (:17), parsing of
  `disputedCategories`/`dispositions` (:53–76, :163–164) and their JSDoc
- Dispute machinery in `analysis/guidance/guidance-store.js`: `disputedCategories`
  legacy fold-in, `dispositions` map, `not_present` suppression, `disputed`/
  `disputeDisposition` fields in `buildConditionItem`, `disputedCount` in the summary,
  the `no_tasks` status branch — plus the affected tests in
  `guidance-store.test.js` (:229, :281, :311 blocks)
- Envelope: `buildGuidanceAssessment` + `assessmentReady`/`assessment` in
  `completeCheck` (checks.js:204, :251, :264, :277) and the API-shape docs in
  frontend/src/services/api.js:247
- `package.json`: `@aws-sdk/client-bedrock-runtime` (validator-only consumer)

Keep: `supersedeOpenTasksForCondition` (amendments), the non-disputed `buildConditionItem`
path, the full guidance question-answer flow.

### PR-C — Terraform + local harness

Delete (verified inventory):
- `infra/modules/app/api.tf:19` — the `description:validate` route entry
- `infra/modules/app/iam.tf:106–110` — `bedrock:InvokeModel` +
  `InvokeModelWithResponseStream` + the foundation-model ARN statement
- `infra/modules/app/lambda.tf:62` — `BEDROCK_MODEL_ID` env
- `infra/modules/app/variables.tf:80–83` — `bedrock_model_id`
- `infra/environments/dev/main.tf:66` + `dev/variables.tf:64`
- `infra/environments/prod/main.tf:66` + `prod/variables.tf:64`

Terraform plan/apply runs in CI per the SDLC rules — the plan diff is the review artifact.
Folded into PR-B's CI run unless review prefers it split.

### PR-D — docs

- Rewrite `perimeter-check-data-flow.md` § 2–3 around the live per-item flow (Done
  finalizes; tasks mint at capture-time `evaluate`); **remove the dispute section**;
  correct the sequence diagram (no Continue-minting leg)
- `architecture.md`: drop the `description:validate` route from any route listing;
  correct the guidance-workflow bullets that reference dispositions
- `frontend/README.md`: remove demo-mode section (dir gone), the `/review` route
  mention, and the mocked-analyzer framing
- `dynamodb-data-model.md`: update the "Task ownership & escalation" section that
  still describes task-routing classification; note `disputed` status retirement
- Close the `screen-trim-verify-leftovers` items for check-review/check-results/analyzer
- Record the `CHECK# grade/summary` write-only follow-on in the issue tracker

## 4. Not-dead guard (kept code, for reviewers)

- `finalizeCaptureScorecard*` + `expectedArtifactCountForCheck` — the live Done path
  (perimeter-check.js:691/:700, problem-report.js:380/:389, today-view.js:621)
- `waitForAnalyses` — used by both finalize paths
- `submitErrorMessage`/`SUBMIT_MESSAGES` — live error copy
- `resumeUploadingCheck`/`resumeSubmittedCheck` — **deleted** per decision 3 (the only
  thing they resumed was the legacy pipeline; the `capture-complete` branch already
  re-finalizes idempotently)
- Amendments endpoints + `supersedeOpenTasksForCondition` — live (tray Edit/Delete)
- Guidance answers flow — live (question cards)

## 5. Verification gates (every PR)

1. `npm run typecheck && npm run lint && npm test` (both workspaces)
2. Local harness smoke: `npm run dev` → submit one photo end-to-end → confirm
   `ANALYSIS#` → `COND#` → `TASK#` and the card renders (CI tests don't cover the live
   path — see the #192 review notes)
3. For PR-C: Terraform plan in CI must show only deletions; no route/env drift
4. Grep sweep post-deletion: zero references to deleted symbols
   (`submitCheck`, `check-review`, `check-results`, `disputedCategorie`, `disposition`,
   `validatePlaceDescription`, `analyzeCheck`, `classifyTask`, `enqueueUpload`)

## 6. Sequencing

1. PR-B (backend) and PR-A (frontend) are independent — either order
2. PR-C (infra) after PR-B (route must not outlive its handler)
3. PR-D (docs) last, so the data-flow doc describes the post-retirement shape

## 7. Doc corrections this plan implies

- `perimeter-check-data-flow.md` currently narrates the legacy Continue-minting flow as
  primary and documents the dispute branch — both corrected/removed in PR-D
- `architecture.md`'s sequence diagram lacks the per-item evaluate + background
  finalize shape; link the data-flow doc as the corrected walkthrough