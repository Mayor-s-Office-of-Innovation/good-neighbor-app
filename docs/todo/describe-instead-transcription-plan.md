# Plan: "Describe Instead" capture flow + browser Web Speech transcription

**Status:** Planned · **Date:** 2026-08-21 · **Owner:** team ·
[index](../README.md)

> **Transcription transport (supersedes the Amazon direction for this feature):**
> voice uses the browser's built-in **Web Speech API**
> (`SpeechRecognition` / `webkitSpeechRecognition`) — client-only recognition,
> no backend, no credential vending, no extra dependencies. This was vetted with a
> throwaway spike before adoption. The earlier
> [transcription-STATUS.md](./transcription-STATUS.md) /
> [transcription-architecture.md](./transcription-architecture.md) describe a
> **client-direct Amazon Transcribe streaming** transport; that path is **not** used
> by this feature (see the caveats in "Transcription implementation plan" below).
> Neither transport routes audio through app compute.

## Goal

Add a side-scoped **"Describe instead"** flow to the perimeter-check capture experience so a user
can describe what they see by **typing** or **recording voice**, validate that description against
street-conditions expectations, save it into the in-progress check draft, and return to the next
side in the capture flow.

This plan covers both:

1. the **frontend screen/flow** launched from the photo capture step, and
2. the **backend work** needed for:
   - AI validation of the typed/transcribed description via Bedrock

   (Voice transcription needs **no** backend — the Web Speech API runs entirely in the
   browser — so there is no credential-vending or identity workstream for this feature.)

## Scope and constraints

- **Launch point:** the flow opens when the user taps **"Describe instead"** from a side in the
  `/check` photo flow.
- **Per-side:** descriptions belong to the current side (`North` / `East` / `South` / `West`), just
  like photos do.
- **Typing:** the user types directly into a native multiline field; focusing it should bring up
  the mobile keyboard with no custom keyboard logic.
- **Voice:** recognition runs **in the browser** via the Web Speech API. Audio does **not** pass
  through app compute (on Chrome/Edge the browser streams it to Google's recognition service; it is
  never sent to our backend).
- **Transcript reveal:** the transcript appears **live while recording** — finalized phrases plus the
  current interim stream into the field as the user speaks, and are committed (appended to any prior
  content) when they stop.
- **Append-only voice:** voice always **adds to** existing content; it never replaces typed or
  previously transcribed text.
- **Validation:** the chips are driven by a Bedrock-backed semantic check that runs when the user
  taps **Continue**.
- **Tooltip:** the Figma tooltip is intentionally out of scope for now.

## Required references

Background docs (describe the **superseded** Amazon transport, kept for history — not the basis for
this feature's voice path):

- [transcription-STATUS.md](./transcription-STATUS.md)
- [transcription-architecture.md](./transcription-architecture.md)

The voice path here follows the browser
[Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) instead; its
seam lives in [frontend/src/services/web-speech-transcribe.js](../../frontend/src/services/web-speech-transcribe.js).

Relevant Figma states:

- Initial empty screen:
  [node 368:12302](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=368-12302&m=dev)
- Recording in progress:
  [node 368:12315](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=368-12315&m=dev)
- Transcript processed:
  [node 368:12369](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=368-12369&m=dev)
- Typing/editing:
  [node 368:12382](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=368-12382&m=dev)
- Transcription error:
  [node 368:12351](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=368-12351&m=dev)
- Exit modal:
  [node 380:15054](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=380-15054&m=dev)
- AI relevance failure:
  [node 380:14634](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=380-14634&m=dev)
- Continue/loading state:
  [node 380:14587](https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=380-14587&m=dev)

## Product behavior

### 1. Entry and exit

- On `/check`, each side exposes **Describe instead** as an alternate evidence path.
- Tapping it opens a dedicated full-screen view for the **current side**.
- Leaving the describe view:
  - with no changes: returns directly to `/check`
  - with unsaved changes: shows the Figma exit-confirm modal
- Successful **Continue**:
  - validates the text
  - saves it to the current side
  - returns to `/check`
  - advances to the next side, or into final submit if this was the last side

### 2. Typing path

- The screen contains a large multiline field for free-form description.
- Tapping/focusing the field uses native browser behavior to show the keyboard.
- The user may type from scratch, edit prior content, or combine typed and transcribed text.

### 3. Voice path

- If there is no content yet, the idle button label is **Use voice**.
- While recording, the label changes to **Stop recording**.
- If content already exists, the idle label becomes **Add more by voice**.
- Transcript text streams into the field **live** as the user speaks (finalized phrases + current
  interim), rendered on top of any prior content without overwriting it.
- Stopping recording finalizes the recognized transcript and **commits** it (appends to prior content).
- If recognition fails, the mic is denied, the device is unsupported, or no speech is detected, show
  the transcription error state and preserve any previously-entered text.

### 4. Validation chips

- Two chips appear below the field:
  - **What you can see**
  - **Where it is**
- Initial state: both gray / unmet.
- Validation runs only when the user taps **Continue**.
- Bedrock evaluates whether the text:
  - contains street-conditions-relevant observations
  - mentions where the issue is
- Validation outcome:
  - pass: relevant chips turn green and the flow advances
  - fail: remain on the screen, show the Figma error state, and reflect which expectations are
    still missing

### 5. Side coverage rule

- A side should count as covered if **any** of these is true:
  - it has one or more photos
  - it was skipped
  - it has a **validated** description

This preserves the existing four-side flow while allowing text/voice to substitute for photos.

## Frontend implementation plan

### A. Add a dedicated route and view

Add a new route such as `/check/describe` and mount a dedicated web component, for example:

- `frontend/src/components/describe-instead.js`
- `frontend/src/components/describe-instead.templates.js`

Update:

- [frontend/src/router.js](../../frontend/src/router.js)
- [frontend/src/components/app-root.js](../../frontend/src/components/app-root.js)

The new view should follow the repo’s current frontend conventions:

- native custom element
- template helper returning HTML strings
- CSS in `frontend/src/styles/app.css`
- semantic controls first
- no extra framework

### B. Extend check-session state

Update [frontend/src/state/check-session.js](../../frontend/src/state/check-session.js) so each
side can hold a persisted description state in addition to photo items.

Preferred shape:

- keep the existing `items[]` approach for eventual submission compatibility
- align the saved description evidence with the analyzer service’s expected **mixed-media request**
  shape, using:
  - the local analyzer contract in
    [../street-conditions-analysis/contract/schemas/analysis-request.schema.json](../../../street-conditions-analysis/contract/schemas/analysis-request.schema.json)
  - the request-shape explanation in
    [../street-conditions-analysis/docs/backend-requirements-update-plan.md](../../../street-conditions-analysis/docs/backend-requirements-update-plan.md)
  - this repo’s current client seam in
    [backend/src/analysis/analyzer-client.js](../../backend/src/analysis/analyzer-client.js)
- store a side-scoped text evidence item such as:
  - `kind: "note"`
  - `text`
  - `source: "typed" | "transcribed" | "mixed"`
  - `validated: boolean`
  - `validation: { whatYouCanSee: boolean, whereItIs: boolean }`

At the draft/UI layer, that can stay ergonomic for the frontend; but before submit it should be
losslessly mappable into the analyzer’s **single-report request** shape:

- required report-level metadata:
  - `reported_at`
  - `latitude`
  - `longitude`
  - `position_descriptor`
- optional report-level metadata:
  - `notes`
- mixed `media[]` array with one or more:
  - image items: `{ type: "image", content_type, base64, metadata? }`
  - text items: `{ type: "text", text, metadata? }`

For description evidence specifically, the frontend-side saved note should be transformable into a
media item equivalent to:

- `{ type: "text", text: "<description text>" }`

Optionally include per-media metadata when useful, following the analyzer contract’s allowed shape,
for example side/capture provenance that GNP needs internally.

Also add transient UI state for the describe screen, such as:

- `isRecording`
- `isTranscribing`
- `isValidating`
- `transcriptionError`

Persist the saved description payload in the same draft store so reload/resume works.

### C. Wire launch from `/check`

Update [frontend/src/components/perimeter-check.js](../../frontend/src/components/perimeter-check.js)
and its templates so tapping **Describe instead** navigates to the new route while retaining the
current side index.

The simplest pattern is to keep the current side index in the session singleton and let the
describe screen read/write against that active side.

### D. Build the screen states

Implement the view to cover the Figma states:

- empty
- recording
- transcript-appended
- editing
- transcription error
- validation error
- continue/loading
- exit-confirm modal

The field should remain editable after any transcript is appended.

### E. Define voice-control behavior

The describe view should own a small voice controller that:

- starts a browser `SpeechRecognition` session (via the `web-speech-transcribe.js` seam)
- streams the live transcript (finalized phrases + current interim) into the field while recording,
  painted on top of the pre-recording text without mutating it
- commits the final transcript (appending to prior content) on stop
- preserves existing typed content

The control logic should expose three clear states:

- idle
- recording
- processing/error

### F. Return-to-flow behavior

On validated continue:

1. save the side description into session/draft state
2. mark the side covered
3. navigate back to `/check`
4. advance to the next side, or submit if already on the last side

## Transcription implementation plan

### A. Use the browser Web Speech API

Voice transcription uses `window.SpeechRecognition || window.webkitSpeechRecognition` directly in
the browser. That means:

- **no backend** — no credential vending, no STS, no device/identity workstream
- **no extra dependencies** — it is a built-in browser API
- audio never transits the app backend (on Chrome/Edge it goes to the browser vendor's recognition
  service; that is the documented trade-off, vetted in the spike)
- it requires a **secure context** (`localhost` or HTTPS) for the mic
- **Firefox has no support**; unsupported browsers get a clear error and the typing path still works

### B. The transcription seam

`frontend/src/services/web-speech-transcribe.js` exports the session contract the describe view
depends on:

```
startTranscribeSession({ siteId, onStateChange, onTranscript }) → { stop(), cancel(), done }
  onStateChange("recording" | "processing")
  onTranscript(liveText)    // cumulative transcript-so-far (final + interim), per result
  done: Promise<{ text }>   // final transcript, or "" on cancel; rejects with a user-facing message
```

`siteId` is accepted for contract parity but ignored (nothing is vended). Internally it:

- feature-detects `SpeechRecognition` and throws a clear unsupported error if absent
- runs `continuous` recognition with `interimResults: true`, streaming the cumulative transcript
  (finalized phrases + current interim) via `onTranscript` for live display
- accumulates finalized phrases; because the engine self-ends after a pause, it **auto-restarts** a
  fresh instance while recording so long dictation isn't cut off
- on `stop()` finalizes and resolves `{ text }`; on `cancel()` aborts and resolves `{ text: "" }`
- caps a session at 60s to match the previous transport's guard

### C. Error handling

Handle at least:

- mic permission denied (`not-allowed` / `service-not-allowed`)
- no microphone present (`audio-capture`)
- recognition/network error (`network`)
- offline
- no speech detected
- unsupported browser (e.g. Firefox)

The describe screen surfaces the transcription-specific error state without clearing prior content.

## Bedrock validation backend plan

### A. Add a dedicated validation endpoint

Add a backend endpoint for description validation, for example:

- `POST /v1/checks/{checkId}/sides/{side}/description:validate`

Input:

- `text`
- `side`
- optional check/site context if useful

Output:

- `accepted: boolean`
- `whatYouCanSee: boolean`
- `whereItIs: boolean`
- `message`

### B. Bedrock prompt contract

The prompt should evaluate whether the text:

1. is about street conditions / relevant field observations
2. includes location information or spatial context

Expected behavior:

- random/unrelated text should fail
- vague text with no location should partially fail
- relevant observational text with location should pass

Use structured output so the frontend can map directly to the two chips.

### C. Frontend behavior on continue

When the user taps **Continue**:

1. set loading state
2. call the validation endpoint
3. update chips from the returned booleans
4. if rejected, show the error state and stay on the screen
5. if accepted, save and return to the next capture side

## Submission-path integration plan

Descriptions must be included in the eventual AI submission path, not just local state.

Update the submission pipeline so side descriptions are submitted alongside photos. The exact
payload shape should follow the analyzer service’s expected `media[]` contract rather than invent a
GNP-only parallel shape. In practice that means:

1. **Persist in GNP as side-scoped text evidence**
   - keep the draft/session model ergonomic for the field app
   - allow typed/transcribed text to behave like other side evidence in review/resume flows
2. **Adapt to analyzer input as text media**
   - emit a text input shaped like `{ type: "text", text: "<description text>" }`
   - pair it with the side’s photo media inputs where present
   - preserve side association in GNP metadata so downstream findings can still be attributed to
     the correct side

The external contract reference for this should be the
`Mayor-s-Office-of-Innovation/street-conditions-analysis` input model, specifically:

- [contract/schemas/analysis-request.schema.json](../../../street-conditions-analysis/contract/schemas/analysis-request.schema.json)
- [docs/backend-requirements-update-plan.md](../../../street-conditions-analysis/docs/backend-requirements-update-plan.md)
- mixed-media examples in
  [test/analyze-handler.test.mjs](../../../street-conditions-analysis/test/analyze-handler.test.mjs)

This repo’s current backend client remains the local seam that must stay aligned with that
contract.

This means descriptions should **not** be planned as free-floating side metadata if that would
sidestep the analyzer’s `media[]` input shape. The safer direction is to treat validated
description content as real text evidence that participates in the same analysis request contract
family as photos.

Because the analyzer contract is **one report with report-level metadata and mixed media**, the
implementation should plan toward eventually sending:

- one report-level `metadata` block for the whole check/report
- photos and validated description text together in the same `media[]` collection

rather than treating each side description as a wholly separate analyzer request unless product
explicitly chooses that split.

This integration should be planned explicitly before implementation so the frontend draft model and
backend contract do not diverge.

## Suggested file touch list

Frontend:

- `frontend/src/router.js`
- `frontend/src/components/app-root.js`
- `frontend/src/components/perimeter-check.js`
- `frontend/src/components/perimeter-check.templates.js`
- `frontend/src/components/describe-instead.js`
- `frontend/src/components/describe-instead.templates.js`
- `frontend/src/services/web-speech-transcribe.js` (the Web Speech session seam)
- `frontend/src/state/check-session.js`
- `frontend/src/services/submit-check.js`
- `frontend/src/styles/app.css`

Backend:

- new description-validation handler / route (Bedrock, with a local heuristic stub for dev)
- tests for the validation path (voice needs no backend, so there is no transcription backend to test)

Docs:

- this plan
- any implementation notes needed to keep `transcription-STATUS.md` current once work starts

## Sequencing

1. **Build the frontend shell**
   - add route
   - add describe screen
   - add typing and exit modal
2. **Extend session state**
   - side-scoped description persistence
   - side coverage semantics
3. **Implement the Web Speech voice flow**
   - `web-speech-transcribe.js` session seam (feature-detect, auto-restart, 60s cap)
   - append transcript on stop
4. **Implement Bedrock validation**
   - backend endpoint
   - chip state mapping
   - continue/error/loading states
5. **Wire return to `/check`**
   - successful continue returns to the correct next side
6. **Integrate with final submit**
   - validated text included in the eventual AI payload
7. **Verify**
   - keyboard-only pass
   - mobile keyboard behavior
   - mic permission flow
   - repeated “add more by voice” append cycles
   - failed transcription
   - failed validation
   - resume draft after reload

## Acceptance criteria

1. From any side in `/check`, the user can open **Describe instead**.
2. The user can either type into a large field or record voice.
3. Voice uses the browser **Web Speech API** (client-only; unsupported browsers fall back to typing).
4. Transcript text streams into the field live while recording, and is committed to the description on stop.
5. If text already exists, voice appends to it and the button reads **Add more by voice**.
6. Continue runs Bedrock validation for:
   - relevant street-conditions content
   - where-it-is content
7. Failed validation keeps the user on the screen and shows the error state.
8. Successful validation saves the payload to the active side and returns the user to the next side
   in the photo flow.
9. The saved description is available to the eventual AI submission path.
