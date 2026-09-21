# Plan: remove "places" from the perimeter check

> **Temporary working document.** Delete this file once both phases ship. Per
> [docs/README.md](./README.md), durable facts move into the reference docs and the
> decision gets an ADR. Written 2026-09-21 against `dev`.

## Goal

Staff should be able to do a perimeter check without first configuring a list of places
for their site. A check is complete when it has **at least five photos, or one saved text
description** of the whole perimeter. Text is a full alternative to photos, not a
supplement: staff who feel unsafe taking photos outside write one description and finish.

## Why

The first-run places setup and the place-by-place capture timeline are the most complex
parts of the app and add friction for every site before the first check. The analysis
pipeline is already per-artifact and does not need places to work.

## Where places live today

The concept runs through every layer. The single-issue flow (`/problem`) already runs the
same capture machinery on one synthetic place, and that precedent is the seam this plan
exploits.

| Layer | What references places |
|---|---|
| Site config | `SITE#<id>` / `#META` carries `places[]` + `placesConfiguredAt`. Written by `PUT /v1/site/places` (`backend/src/handlers/site.js`), seeded by `backend/scripts/lib/site-code-seeds.mjs`, initialized empty by admin site creation (`backend/src/handlers/admin.js`). |
| First-run gate | `frontend/src/components/app-root.js` `hasConfirmedPlaces` redirects every route to `/places/setup` until the site has confirmed places. Home settings menu has "Edit places" (`today-view.js`). |
| Places screens | `frontend/src/components/places-setup.js`, `.templates.js`, `.test.js` and the `places-flow` / `places-row` CSS in `app.css`. |
| Session state | `frontend/src/state/check-session.js` is keyed by `placeOrder[]` + `places{}` (items, skipped, reviewed, inputMode, draftText, conditionLabels, description). Every mutation takes a `placeId`. |
| Capture screen | `frontend/src/components/perimeter-check.js` + `.templates.js`: per-place timeline, expand/collapse, "Continue to X" / "Skip for now", "Type instead", "Add place" dialog, Finish confirm that counts places without evidence. The photo menu (note / replace / move / remove) is wired to a handler that only closes the menu, so none of those actions work today. |
| Pipeline | `photo-analysis.js` sends the place list on `POST /v1/checks` and `placeId` + `placeName` on every upload. `backend/src/handlers/artifacts.js` returns 400 without them. The S3 key and the `ART#` sort key embed `placeId` (`keys.js`). The analyze worker sends `placeName` to the analyzer as `position_descriptor`. `ANALYSIS#` items and the analytics export (`analytics/convert.js`, `reports.js`) carry `placeId` / `placeName`. Result cards label evidence with the place name (`analysis-results.templates.js`, `today-view.js` `hydrateTaskEvidence`). |
| Infra | `infra/modules/app/api.tf` lists `PUT /v1/site/places` and a dead `POST /v1/checks/{checkId}/places/{placeId}/description:validate` route with no handler. |
| Tests | `e2e/helpers/app.js` clicks through the places gate and drives `.place-row` selectors; `e2e/global-setup.mjs` resets seeded places; unit tests for the capture screen, templates, session, and backend handlers assert place fields. |
| Docs | `perimeter-check-data-flow.md`, `dynamodb-data-model.md`, `architecture.md` describe per-place artifacts. |

## Decisions

1. **Completion rule.** `photoCount >= 5 || textCount >= 1`. One helper in a shared domain
   module owns the rule and the constant; the capture screen, Finish button, and tests all
   call it.
2. **Enforcement is client-side only.** Finish stays disabled until the rule is met. The
   backend records counts at completion but does not refuse. The background scorecard
   finalization re-runs on every home load, so a server-side 409 would loop forever.
3. **Text evidence is a first-class alternative.** One description per check satisfies the
   rule on its own. Mixed evidence counts: two photos plus a description is complete, and
   the photos stay attached. The description registers as a text artifact through the
   existing text registration path and is analyzed like a photo.
4. **Description minimum length.** Raise from 5 characters to about 20 so a description is
   meaningful. Keep the existing prompt copy: "Describe the whole area, even if there are no
   problems."
5. **Analyzer `position_descriptor`.** Send the site name instead of a place name. The
   current fallback is the literal string `"perimeter"`; the site name is more useful on task
   cards and 311 escalations.
6. **Old data.** Leave `places` on existing `SITE#` items and leave old `ART#` keys alone.
   `getCheck` and `presignMedia` use prefix queries and match on `artifactId`, so no
   migration is needed.
7. **Upper bound.** Optional soft cap on photos per check to bound analysis cost. Not
   required for Phase 1.

## Phase 1: flat photo roll (one PR)

Reuse the synthetic-place trick so the analysis pipeline, result cards, deletion, answer,
and retry flows keep working untouched. The place id is a constant, so every code path
that keys on `placeId + itemId` still resolves.

### Frontend

- `check-session.js`: `startCheck` creates one fixed synthetic place named after the site,
  mirroring `SINGLE_PROBLEM_PLACE`. Drop the per-place `inputMode`, `draftText`, and
  `description` fields; text evidence becomes an ordinary item of kind `text`, which the
  session already supports. Remove `addPlaceToCheck`, `skipPlace`, `reviewPlace`,
  `setPlaceInputMode`, `setPlaceDraftText`, `setPlaceDescription*`.
- New domain module (`frontend/src/domain/check-completion.js`): `MIN_PERIMETER_PHOTOS = 5`,
  `photoCount(check)`, `textCount(check)`, `isCheckComplete(check)`. Replace
  `domain/place-evidence.js`.
- `perimeter-check.js` + `.templates.js`: rewrite as a flat photo grid. The problem-report
  grid tiles (`shotTile`, `addTile`) already exist as compatibility exports in the templates
  file, so reuse them.
  - Progress line: "3 of 5 photos" until the rule is met, then "Ready to finish".
  - Finish disabled below both thresholds with the hint "Take 5 photos, or describe the
    area instead."
  - Secondary button "Describe instead" where "Type instead" is today. It navigates to
    `/check/describe`.
  - A saved description renders as a card above the grid with edit and remove. Remove
    restores the photo requirement.
  - Remove: the timeline, Add place dialog, Continue / Skip, per-place text mode, the
    incomplete-places dialog, and the broken photo menu. Keep: cancel / pause sheet,
    the analyzing tray, the elapsed ticker, retry and remove on failed items.
- `describe-instead.js`: extend the single-problem branch of `_onContinue` (add a text item,
  start analysis, navigate back) to the perimeter flow and delete the branch that writes a
  per-place description. One code path for text evidence. Bump the minimum length.
- `app-root.js`: remove `hasConfirmedPlaces`, the `/places/*` routes, the
  `siteplacesupdated` listener; after `sitebound` navigate straight to `/today`.
- `main.js`: drop the `places-setup` import. Delete `places-setup.js`, `.templates.js`,
  `.test.js`.
- `today-view.js`: remove "Edit places" from the settings menu; `resumeOrStartCheck(siteId)`
  without places.
- `photo-analysis.js`: stop sending `places` on `createCheck`; send the site name as
  `placeName` on upload and text registration.
- `analysis-results.templates.js`: evidence label fallback from "Place" to the site name
  or hidden.
- `db.js`: drop `saveSitePlaces`.
- `app.css`: delete `places-flow`, `places-row`, `places-menu`, `place-row`,
  `place-timeline`, `add-place-dialog`, `done-incomplete-dialog` rules.

### Backend and infra

- `artifacts.js`: make `placeId` / `placeName` optional on presign and register, defaulting
  to a fixed id and the site name, so the API is not coupled to the client change.
- `checks.js`: stop storing `places` on the header. At `completeCheck`, record `photoCount`,
  `textCount`, and `evidenceKind` (`photos` | `description` | `mixed`) on the header so the
  compliance report can show how often the text path is used.
- Remove `PUT /v1/site/places` from `lambda/api.js`, `scripts/local-api.mjs`, and `api.tf`.
  Remove `putSitePlaces` and `normalizePlaces` from `site.js` (keep `getSite`). Remove the
  dead `description:validate` route from `api.tf`.
- `site-code-seeds.mjs`: stop seeding places. `admin.js`: stop writing `places: []`.

### Tests

- `e2e/helpers/app.js`: drop the gate branch in `bindSite` and the `.place-row` selectors in
  `startCheck`. `e2e/global-setup.mjs`: drop the places reset.
- `e2e/tests/perimeter-check.e2e.spec.js`: upload five photos, assert Finish is disabled
  until the fifth lands, keep the card assertions.
- New e2e path: start a check, describe instead, assert Finish enables with zero photos,
  assert a task card appears from the text analysis (the analyzer stub fixtures cover it).
- Unit tests for `isCheckComplete`: four photos + no text, five photos, zero photos + one
  description, two photos + one description.
- Update `perimeter-check.test.js`, `perimeter-check.templates.test.js`,
  `check-session.test.js`, `submit-check.resume.test.js`, `photo-analysis.*.test.js`,
  `describe-instead.test.js`, `checks.test.js`, `artifacts.test.js`.

### Docs

- Update `perimeter-check-data-flow.md`, `dynamodb-data-model.md`, `architecture.md`,
  `frontend/README.md`.
- Add ADR 0014 recording the decision and the completion rule.

## Phase 2: remove the place layer (cleanup PR)

Refined 2026-09-21 against `feature/no-places-v2` (Phase 1 merged, all suites green).
Once the UI no longer depends on places, strip the plumbing. No user-visible change.

### Decision: the analyzer's `position_descriptor`

The analyzer requires a `position_descriptor` string ("where was this taken"). Phase 1
fills it with the site name via `placeName`; Phase 2 drops that field from the wire and
storage. Nothing in our system decides anything on the value: the analyzer echoes it, the
guidance handler copies it onto tasks as `source.positionDescriptor`, and the only reader
is a fallback label on task cards. So the worker sends the fixed literal `"perimeter"`
(already its fallback), no site-name lookup is added, and evidence labels on cards use the
bound site's name from local `getSite()`, falling back to `artifact.placeName` for
pre-Phase-2 rows. Decided 2026-09-21.

### Backend

- `keys.js`: `artifactKey(siteId, checkId, artifactId)` → `CHECK#<checkId>#ART#<artifactId>`.
  `checkArtifactPrefix` and `checkChildrenPrefix` are unchanged, so `getCheck`,
  `completeCheck`, `deleteArtifact`, and `presignMedia` keep reading old four-segment
  keys (they already match on `artifactId`, never on the key). Update `keys.test.js`.
- `artifacts.js`: delete `DEFAULT_PLACE_ID`, `normalizePlaceName`, and the `placeId`
  validation; `mediaKey` becomes `checks/<siteId>/<checkId>/<artifactId>` (the no-graft
  prefix check still holds). Presign response, the `ART#` item, and the SQS message drop
  both fields. **Ignore** `placeId` / `placeName` if a stale client still sends them
  (devices mid-deploy must not 400). Replace the "defaults placeId" tests with "ignores
  legacy place fields"; update every `place-north` key fixture.
- `analyze-artifact.js`: drop the two fields from `AnalyzeMessage`, `markFailed`, and the
  analyzed item; `buildMetadata` sends the fixed `position_descriptor`.
- `checks.js` `completeCheck`: drop `placeId` / `placeName` from the `AnalyzedArtifact`
  mapping. `synthesize-check.js`: drop the two typedef props and the "across places"
  comments. Update `checks.test.js` fixtures (`artifactItem` / `analyzedItem` helpers).
- `analytics/convert.js`, `reports.js`: drop the `placeId` / `placeName` columns from
  `artifacts`. Old Parquet files keep the columns; `union_by_name` fills NULL for new
  files, and nothing in `reports.js` selects them. Update `convert.test.js`.
- `guidance.js`: untouched (`positionDescriptor` still arrives via the client assessment).

### Frontend

- `check-session.js`: the check is `{ id, siteId, flowType, window, startedAt, items[],
  status, … }`. Mutation API: `addItem(item)`, `removeItem(itemId)`, `updateItem(itemId,
  patch)`, `updateItemAnalysis(itemId, patch)`; readers `getItems()`, `findItem(itemId)`.
  Delete `PERIMETER_PLACE_ID`, `SINGLE_PROBLEM_PLACE`, `perimeterPlace`, `getPlaceOrder`,
  `getPlace`, `getCapturePlaceId`, and the `siteName` argument on `startCheck` /
  `ensureCheck` / `resumeOrStartCheck`. Items carry no `placeId` / `placeName`.
- **Draft migration** lives in `normalizeCheck`: when a persisted record has `places`,
  concatenate `places[placeId].items` in `placeOrder` order into `items[]` and drop
  `places` / `placeOrder`. Apply the same normalizer in `loadSubmitted` (it assigns the
  raw review record today). No `DB_VERSION` bump: the draft and review stores are
  out-of-line and schemaless. Unit-test with a pre-Phase-2 fixture (two places, mixed
  photo/text items, an in-flight upload).
- `domain/check-completion.js`: `checkItems` reads `check.items` (keep a `places`
  fallback out; the normalizer owns compatibility). `submit-check.js`
  `expectedArtifactCountForCheck` reads `items`.
- `services/photo-analysis.js`: every function takes `itemId` only; the `active` set is
  keyed by `itemId`; the register / upload / text calls drop `placeId` / `placeName`;
  `assessmentFromAnalysis` keeps its `"perimeter"` descriptor. The `tag` for
  perf spans becomes `item.id`.
- `services/api.js`: drop the two fields from `presignArtifact`, `registerArtifact`,
  `uploadArtifact`, `registerTextArtifact` signatures and typedefs.
- `analysis-results.templates.js`: drop `data-place-id` from both card templates and the
  `placeId` typedef props; evidence label = `item.placeName || siteName || "Site"`, with
  `siteName` passed by the host through the tray options. `taskAnalysisCard` keeps its
  `positionDescriptor` fallback chain for history tasks.
- `perimeter-check.js`, `problem-report.js`, `today-view.js`, `describe-instead.js`:
  drop `_placeId`, `_placeState`, `_sessionItems` (use `getItems()`), and the
  `problem.placeId` guards; `_problemFromCard` drops `placeId`; the `camera:open` mark
  drops its `placeId` field. `analysis-card-deletion.js` matches on condition +
  artifact id already and needs no change.
- `perimeter-check.templates.js` `shotTile`: alt text drops the `for <placeName>` suffix.
- `domain/check-adapter.js`: comment only.

### Tests

- Backend: `keys.test.js`, `artifacts.test.js`, `checks.test.js`,
  `analyze-artifact.test.js`, `synthesize-check.test.js`, `convert.test.js`.
- Frontend: `check-session.test.js` (add the migration cases), `check-completion.test.js`,
  `submit-check.resume.test.js`, `describe-instead.test.js`,
  `analysis-results.templates.test.js`, `perimeter-check.templates.test.js`,
  `photo-analysis.{retry,refresh,location}.test.js`.
- E2E: nothing references places or `data-place-id` today; run the suite unchanged.

### Docs

- `dynamodb-data-model.md`: artifact key row, the "synthetic place" note, and item 5 of
  the retired-concepts list.
- `perimeter-check-data-flow.md`: presign / register lines in the sequence diagram, the
  three write-point table rows, the "placeId optional" note, and the final-records table.
- `architecture.md`: the presign line and the worker `placeName` line.
- `dev-commands.md` line 109 still says places-setup shows after re-binding — stale since
  Phase 1; fix it here.
- ADR 0014: add a status line that Phase 2 shipped and the key is now three segments.
- Then delete this file (per the header) once the PR merges.

### Order of work

1. Backend keys → artifacts → worker → completeCheck → analytics, tests green after each.
2. Session flatten + migration + domain/submit-check, with tests.
3. Services (`photo-analysis.js`, `api.js`).
4. Components and templates.
5. Docs, then `npm test`, `npm run typecheck`, `npm run lint`, and the e2e suite.

## Risks

- **Draft compatibility.** Phase 1 leaves the session shape alone, so in-progress drafts
  resume. Phase 2 needs the migration above.
- **E2E coupling.** The suite depends on the gate and place rows; it must change in the
  same PR or CI fails.
- **Devices at the gate.** A device sitting on the places setup screen lands on home after
  the deploy with no action needed.
- **Text-only analysis quality.** The analyzer grades text artifacts today, but the
  description path will now carry whole checks. Watch the first week of `evidenceKind =
  description` checks for empty or low-signal results.

## Rough size

Phase 1 touches around fifteen source files plus tests, deletes three components and
roughly 250 lines of CSS. Phase 2 touches about thirty files, half of them tests, with no
user-visible change.
