# Perimeter Check Rebuild: Photo-Level Analysis Plan

Status: implemented in the current perimeter-check rebuild pass.

## Goal

Rebuild the perimeter check flow so the "perimeter check" is no longer the unit of
analysis. It remains the user-facing walk through a site's places, but each submitted
photo is uploaded, analyzed, evaluated by the rulebase, and surfaced as its own result.

Duplicate or overlapping tasks are acceptable. If two photos show the same issue, both
photos may produce tasks; deciding what to keep, edit, or delete belongs to the user.

## Design Inputs

- Initial photo-place timeline: Figma node `1361:11568`.
- Typed alternative: Figma node `1401:17133`.
- Add-place modal: Figma node `1433:22076`.
- Add-place enabled state: Figma node `1430:21220`.
- Add-place duplicate error: Figma node `1433:22033`.
- Add-place toast: Figma node `1433:21704`.
- Photo captured, footer controls, collapsed analysis disclosure: Figma node `1361:11620`.
- Expanded analyzing section placement: Figma node `1412:19410`.
- Advanced analyzing/result card design: Figma nodes `1339:7636` and `1342:9018`.
- In-progress analyzing card: Figma node `1417:20264`.
- Completed result card: Figma node `1342:9019`.
- Photo overflow button: Figma node `1433:21735`.
- Photo overflow menu in context: Figma node `1433:21714`.
- Photo overflow menu: Figma node `1433:21901`.

Use the Figma output as reference only. Convert to the repo's native JavaScript, web
component, Web Awesome, and plain CSS patterns.

## Architecture Change

Current architecture:

1. A check is captured across places.
2. Photos are uploaded eagerly but not registered.
3. On final submit, the app creates/registers artifacts, waits for all analyses, completes
   the check, then evaluates the synthesized assessment.

Target architecture:

1. A check session starts as a capture/navigation container.
2. The backend check header is created before the first photo is registered, either on
   flow start or lazily on first photo.
3. Each captured photo becomes an analysis unit:
   - upload bytes,
   - register artifact,
   - enqueue analysis,
   - poll for that artifact's analysis,
   - build a photo-level assessment,
   - call `POST /v1/assessments:evaluate`,
   - render the resulting condition/task card.
4. Each typed description submitted instead of a photo also becomes an analysis unit. It is
   registered through the text-artifact path and passed as media/input for analysis, then
   evaluated by the same photo-level rulebase flow.
5. The footer `Done` button remains visible at the bottom but is left unwired in this pass.
   Later, `Done` will complete the check and navigate home. There will be no intermediate
   review stage; review happens in cards on this view or from home.
6. Check-level completion should not block photo-level analysis. It is only the eventual
   terminal action for `Done`.

## Implementation Plan

Build and test this as one integrated change. The UI state and incremental photo-analysis
pipeline are tightly coupled enough that splitting them would create too much mock-only
surface area and likely require reworking the first pass.

Files likely touched:

- `frontend/src/components/perimeter-check.js`
- `frontend/src/components/perimeter-check.templates.js`
- `frontend/src/state/check-session.js`
- `frontend/src/styles/app.css`
- `frontend/src/state/check-session.test.js`
- `frontend/src/services/api.js`
- `frontend/src/services/artifact-uploader.js`
- `frontend/src/services/submit-check.js` or a new `photo-analysis.js`
- `frontend/src/domain/check-adapter.js`
- `backend/src/handlers/checks.js`
- `backend/src/handlers/artifacts.js`
- `backend/src/handlers/guidance.js`
- `backend/src/analysis/synthesize-check.js`
- `backend/src/analysis/guidance/*`

Workstream A: timeline and capture UI.

1. Replace the current single-place shot grid view with a vertical timeline that renders all
   places in order.
2. Track one expanded place at a time. `Next place` and `Skip for now` collapse the current
   place and expand the next place.
3. Render collapsed places with:
   - place name,
   - skipped/photo/text/analyzing summary,
   - returned condition labels as they become available.
4. Render the active place in one of two modes:
   - photo mode with prompt text, photo tiles, `Skip for now`, `Type instead`, and
     `Next place` after evidence exists;
   - text mode with textarea, `Review conditions`, and `Take a photo instead`.
5. Preserve the existing native camera/file input behavior for `Take photo` and detail-photo
   tiles.
6. After one photo exists, show an empty first tile labeled `Add detail photo` plus the
   captured photo tile, matching the updated mock ordering.
7. Overlay a `...` button in the top-right of each captured image tile.
8. When the image `...` button is tapped, open the photo overflow menu. The menu should include:
   - `Add note`,
   - `Replace photo`,
   - `Move to another place`,
   - `Remove photo`.
9. Leave all photo overflow menu actions unwired in this pass.
10. Add transient additional places through the modal. These places are added only to the
   current check session, never to site presets.
11. Add modal validation:
   - disabled `Add place` while trimmed text is empty,
   - enabled state when non-empty,
   - duplicate check against current check place names, case-insensitive and trimmed,
   - duplicate error text: `This place is already in the check.`
12. Show the success toast/callout after adding a place.
13. Add footer controls at the bottom:
    - `Done` primary button, left unwired,
    - `Analyzing` disclosure button when there are analyzing/results items,
    - `Hide analyzing...` when the analysis section is open.
14. Add the expandable analyzing section below the footer controls. It should show both
    in-progress and completed analysis units until a later dismissal/removal behavior exists.
15. Render uploading/analyzing items with the in-progress card from node `1417:20264`.
16. Render completed items with the completed result card from node `1342:9019`.
17. Leave card edit/delete buttons present but unwired.

Workstream B: session state.

1. Extend the current check session so each evidence item can carry upload/registration,
   analysis, assessment, condition, and task status.
2. Persist these fields in the draft so reload/resume can continue uploads and polling.
3. Add transient place mutation helpers for add-place modal behavior.
4. Add active-place, text/photo mode, and analyzing-section state helpers.
5. Add state for the open photo overflow menu, keyed by item ID.
6. Update collapsed place summaries from the item-level analysis results.

Suggested state shape additions:

```js
{
  activePlaceIndex: 0,
  analyzingOpen: false,
  placeOrder: ["place-1"],
  places: {
    "place-1": {
      inputMode: "photo",
      skipped: false,
      items: [
        {
          id: "item-1",
          kind: "photo",
          dataUrl: "data:image/jpeg...",
          text: undefined,
          note: "",
          upload: { status: "queued|uploading|uploaded|failed" },
          analysis: {
            status: "idle|queued|analyzing|analyzed|failed",
            artifactId: "artifact-1",
            conditions: [],
            tasks: []
          }
        }
      ],
      conditionLabels: ["Waste & Small Debris"]
    }
  }
}
```

Workstream C: incremental upload, analysis, and guidance.

1. Add a client helper to ensure the backend check exists before registering a photo. This
   can call existing `createCheck(check.id, { places })` idempotently.
2. Change eager photo upload from "upload bytes only" to "upload bytes, then register this artifact"
   once the check exists.
3. For typed descriptions, register a text artifact immediately after the user submits
   `Review conditions`; treat that text artifact as the analysis unit.
4. Record `artifactId`, `s3Key`, `contentType`, and registered/queued status back onto the
   photo item.
5. Poll `GET /v1/checks/{checkId}` for the specific artifact's `ANALYSIS#` item. Avoid
   waiting for all artifacts in the check.
6. Build an item-level assessment from that single analysis. Each concern should become a
   condition with stable IDs scoped to the artifact/evidence item, for example:
   `artifactId-001-waste-small-debris`.
7. Call `POST /v1/assessments:evaluate` immediately for that item-level assessment. It is
   acceptable for this to create duplicate or premature durable tasks.
8. Store the returned assessment, conditions, and tasks on the evidence item.
9. Render one card per returned task/condition in the analyzing section. Cards should include:
   - problem title,
   - description,
   - action/escalation/non-actionable escalation outcome,
   - edit button,
   - trash button,
   - source photo or typed-evidence indicator,
   - place badge/label.
10. When analysis returns, update the collapsed place summary with condition labels from that
    evidence item.
11. Keep final `completeCheck` out of this pass unless `Done` is explicitly wired later.

Backend options:

- Prefer reusing existing `registerArtifact`, `registerTextArtifact`, and `evaluateAssessment`
  endpoints if the frontend can build the item-level assessment from a returned analysis item.
- If frontend assessment construction becomes too duplicative, add a backend endpoint such
  as `POST /v1/checks/{checkId}/artifacts/{artifactId}/assessment:evaluate` that reads one
  analysis, builds the item-level assessment, calls the guidance store, and returns the
  result. This keeps condition ID generation and rulebase inputs server-owned.

## Test Plan

State and UI:

- State tests for transient place addition and duplicate detection.
- State tests for active-place movement, skip, collapse, and text/photo mode switching.
- Component tests for footer disclosure behavior and analyzing section placement.
- Component tests for condition labels appearing in collapsed places.
- Component tests for the photo `...` button and overflow-menu visibility.
- Component tests proving overflow-menu actions render but do not mutate state yet.

Async pipeline:

- Upload service tests proving captured photos register immediately after upload.
- Text artifact tests proving typed descriptions register and analyze through the same
  item-level flow.
- Polling tests proving one artifact can complete without waiting for the whole check.
- Adapter tests for single-analysis to photo-level assessment.
- Guidance tests proving duplicate photo-level evaluations can create separate tasks.
- Error-state tests for upload failure, analysis timeout, and guidance evaluation failure.

Integrated acceptance:

- Capturing one photo creates/registers one artifact and begins analysis.
- Submitting a typed description creates/registers one text artifact and begins analysis.
- Capturing multiple photos of the same issue can produce multiple task cards.
- Moving to the next place does not interrupt analysis from the previous place.
- Collapsed places update with returned condition labels.
- The analyzing disclosure opens and hides the shared card section, which includes both
  in-progress and completed cards.
- In-progress cards follow node `1417:20264`; completed cards follow node `1342:9019`.
- Captured photo tiles include the top-right `...` button and open the overflow menu.
- `Done` is visible at the bottom and remains unwired for this pass.

Run before merging:

```bash
npm run test --workspaces --if-present
npm run typecheck --workspaces --if-present
npm run lint --workspaces --if-present
```

## Decided Follow-Ups

1. Typed descriptions are analysis units, using text artifacts passed through the same
   analysis and rulebase flow.
2. `Done` will eventually complete the check and navigate home. There is no intermediate
   review stage.
3. The analyzing dropdown shows both in-progress and completed evidence items until later
   edit/delete/dismissal behavior is wired.
4. Photo overflow menu actions are visible in this pass but intentionally unwired.
