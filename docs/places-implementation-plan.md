# Places Implementation Plan

Status: planned

## Goal

Replace the perimeter-check "sides" model with configurable, ordered "places".
Places can be streets, street segments, entrances, or any other geographically
located area that the site team recognizes. The saved order defines the order
used during each perimeter check.

This repository only contains test data and test records, so the implementation
does not need to preserve backward compatibility for existing `side` records.
API fields, routes, docs, and tests should be renamed fully from `side`/`sides`
to `place`/`places`.

## Product Behavior

### First Launch

After a device is bound to a site, the app should send the user to the places
setup flow before the home screen. The user must save at least one place before
they can proceed to the home screen.

Some sites may already have places configured by an administrator. These are
returned by the backend site settings API after binding and should pre-populate
the setup flow.

If seeded places exist, use this copy:

- Title: `Places you check`
- Subtitle:
  `Take photos at these places around your site.`
  `We added a few to get you started.`
  `Change the names or order if needed.`

If no seeded places exist, use this copy:

- Title: `Add the places you check`
- Subtitle:
  `Add the places where you take photos.`
  `Use street names or simple names that your team recognizes, like "6th St" or "Front entrance."`
  `Put them in the order you will check on them.`

When there are no seeded places, show one empty text field with placeholder:

`Example: 6th St., or, Front entrance`

All other UI behavior remains the same.

### Adding Places

The user can tap `Add place` to append a new empty row. The new input placeholder
is:

`Example: 6th St., or, Front entrance`

While an empty row exists, disable `Add place`, matching the Figma state. Saving
is disabled until at least one non-empty place name exists.

### Reordering And Removing

Each row has a right-side menu button. Tapping it opens a menu with:

- `Move up`
- `Move down`
- `Remove`

`Move up` and `Move down` must immediately reorder the item in the visible list
and in the draft state for the screen. Disable or omit boundary-invalid actions:
the first item cannot move up, and the last item cannot move down.

`Remove` opens a confirmation modal:

- Title: `Remove "{placeName}"?`
- Body: `It will no longer appear in future perimeter checks. Previous check records won't be affected.`
- Primary action: `Keep place`
- Danger action: `Remove location`

Confirmed removal updates the list immediately.

### Editing Later

Add a settings icon button in the top right of the home screen. Tapping it opens
the same places screen in edit mode.

Edit-mode copy:

- Title: `Edit places`
- Subtitle: `Update the places included in each perimeter check`

Edit mode includes a back caret button in the top left.

If the user taps the back caret with unsaved changes, show a confirmation modal:

- Title: `Discard changes?`
- Body: `Your changes to the check locations haven't been saved.`
- Primary action: `Keep editing`
- Danger action: `Discard changes`

If there are no unsaved changes, the back caret returns directly to the home
screen.

## Figma References

- Initial seeded screen: `https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=1278-5587&m=dev`
- Add-place state: `https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=1278-6336&m=dev`
- Row menu: `https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=1278-6601&m=dev`
- Delete confirmation: `https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=1278-5955&m=dev`
- Unsaved exit confirmation: `https://www.figma.com/design/muHTWTeWZtAiTmHE1UMxJd/Good-Neighbor-App?node-id=1279-7662&m=dev`

## Data Model

### Site Settings

Store places on the site configuration, not on the site-code binding response.
The site-code flow should only bind the device.

Suggested site shape:

```js
{
  siteId: "site-health-center-mission",
  providerSiteId: "provider-site-health-center-mission",
  name: "Health Center Mission",
  places: [
    {
      id: "place_01K...",
      name: "15th St",
      order: 0
    },
    {
      id: "place_01K...",
      name: "Front entrance",
      order: 1
    }
  ],
  placesConfiguredAt: "2026-09-03T12:00:00.000Z",
  updatedAt: "2026-09-03T12:00:00.000Z"
}
```

Place IDs should be stable once created so historical check artifacts can refer
to the configured place even if the display name changes later.

### Check Session

Replace the current local `sideOrder`/`sides` shape with `placeOrder`/`places`.

Target local check shape:

```js
{
  id: "check_...",
  siteId: "site-health-center-mission",
  flowType: "perimeter",
  placeOrder: ["place_1", "place_2"],
  places: {
    place_1: {
      id: "place_1",
      name: "15th St",
      items: [],
      skipped: false,
      description: null
    },
    place_2: {
      id: "place_2",
      name: "Front entrance",
      items: [],
      skipped: false,
      description: null
    }
  },
  activePlaceIndex: 0,
  status: "in-progress"
}
```

The single-problem flow should keep using the same capture machinery with a
synthetic place, for example:

```js
{
  id: "problem",
  name: "Problem"
}
```

## Backend API

### Site Code

Keep `/site-code` focused on device binding only. It should return the bound site
identity, but not serve as the places/settings contract.

Response shape:

```json
{
  "code": "123456",
  "providerSite": {
    "id": "provider-site-health-center-mission",
    "siteId": "site-health-center-mission",
    "name": "Health Center Mission"
  }
}
```

### Site Settings

Add:

```text
GET /v1/site
PUT /v1/site/places
```

`GET /v1/site` returns the site settings, including current places.

`PUT /v1/site/places` replaces the site's ordered places list. The request must
contain at least one place with a non-empty name.

Suggested request:

```json
{
  "places": [
    { "id": "place_1", "name": "15th St" },
    { "id": "place_2", "name": "Front entrance" }
  ]
}
```

Suggested response:

```json
{
  "site": {
    "siteId": "site-health-center-mission",
    "name": "Health Center Mission",
    "places": [
      { "id": "place_1", "name": "15th St", "order": 0 },
      { "id": "place_2", "name": "Front entrance", "order": 1 }
    ],
    "placesConfiguredAt": "2026-09-03T12:00:00.000Z",
    "updatedAt": "2026-09-03T12:00:00.000Z"
  }
}
```

Validation rules:

- Reject an empty places array.
- Trim names.
- Reject blank names.
- Reject duplicate IDs in the request.
- Generate IDs server-side for rows without IDs, or require the frontend to
  generate IDs before sending. Prefer frontend IDs for instant local state and
  simpler optimistic UI.
- Persist normalized `order` values based on array order.

## Check And Artifact API Rename

Rename the check and artifact contracts from side-based fields to place-based
fields.

### Create Check

Current:

```json
{
  "sides": [
    { "side": "North", "skipped": false }
  ]
}
```

Target:

```json
{
  "places": [
    { "placeId": "place_1", "placeName": "15th St", "skipped": false }
  ]
}
```

The check header should persist `places`, not `sides`.

### Presign Artifact

Current body:

```json
{
  "side": "North",
  "contentType": "image/jpeg"
}
```

Target body:

```json
{
  "placeId": "place_1",
  "placeName": "15th St",
  "contentType": "image/jpeg"
}
```

The generated S3 key should use `placeId` rather than a mutable display name:

```text
checks/{siteId}/{checkId}/{placeId}/{artifactId}
```

### Register Artifact

Target body:

```json
{
  "artifactId": "artifact_1",
  "placeId": "place_1",
  "placeName": "15th St",
  "s3Key": "checks/site/check/place_1/artifact_1",
  "contentType": "image/jpeg",
  "capturedAt": "2026-09-03T12:00:00.000Z",
  "text": "optional text"
}
```

Artifact items should persist `placeId` and `placeName`, not `side`.

### Description Validation

Rename the route:

```text
POST /v1/checks/{checkId}/places/{placeId}/description:validate
```

The request body should include `placeName` if the validator needs human-readable
context.

The analyzer prompt should say:

```text
Place context: {placeName}.
```

not:

```text
Side context: {side}.
```

## Frontend Implementation

### Services

Update `frontend/src/services/api.js`:

- Add `getSiteSettings()`.
- Add `putSitePlaces(places)`.
- Rename side-based check/artifact function parameters to place-based parameters.
- Rename `validateSideDescription()` to `validatePlaceDescription()`.

Update `frontend/src/services/onboarding.js`:

- Keep site-code validation focused on binding.
- Do not expect seeded places from `/site-code`.

Update `frontend/src/services/submit-check.js` and
`frontend/src/services/artifact-uploader.js`:

- Plan artifacts by `placeOrder`.
- Include `placeId` and `placeName` in upload/register calls.
- Create checks with `places`.
- Generate artifact signatures from place fields, not side fields.

### Local Persistence

Update `frontend/src/db.js`:

- Store site settings fields on the existing `site` record.
- Consider adding helper functions such as `saveSiteSettings()` or
  `saveSitePlaces()` to avoid forcing UI components to rewrite unrelated binding
  fields.

### Places Screen

Add:

- `frontend/src/components/places-setup.js`
- `frontend/src/components/places-setup.templates.js`

Responsibilities:

- Load bound site and current site settings.
- Decide first-run seeded vs first-run empty copy.
- Maintain an editable places draft.
- Track dirty state.
- Add blank rows.
- Remove blank rows without confirmation.
- Confirm removal of named rows.
- Move rows up/down immediately.
- Save normalized places through `PUT /v1/site/places`.
- Persist returned settings locally.
- Navigate to `/today` after save.
- In edit mode, support the back-caret discard confirmation.

### Routing And First-Run Gate

Update `frontend/src/components/app-root.js`:

- Add `/places/setup` and `/places/edit` routes.
- After site binding, fetch `GET /v1/site`.
- If places are missing or not configured, navigate to `/places/setup`.
- Prevent direct navigation to `/today`, `/check`, `/problem`, `/review`, or
  `/results` until at least one place has been saved.

Update `frontend/src/components/site-setup.js`:

- After successful site-code binding, save the binding and dispatch the event.
- Let `app-root` decide whether to route to `/places/setup` or `/today`.

### Home Screen

Update `frontend/src/components/today-view.js`:

- Add a settings icon button in the top right.
- Use `aria-label="Edit places"`.
- On click, navigate to `/places/edit`.

### Perimeter Check Screen

Update `frontend/src/components/perimeter-check.js` and
`frontend/src/components/perimeter-check.templates.js`:

- Start a perimeter check from saved ordered places.
- Replace side terminology in visible copy and accessibility labels.
- Use place names in progress, photo alt text, and description labels.

Suggested copy:

- Progress: `{placeName} · {index} of {total}`
- Skip button: `Skip place`
- Previous button: `Previous place`
- Next button: `Next place`
- Segment aria label: `Place {index}: {state}`
- Grid aria label: `Evidence for this place`
- Description aria label: `Edit description for {placeName}`

### Review And Results

Update:

- `frontend/src/components/check-review.js`
- `frontend/src/components/check-results.js`
- `frontend/src/domain/check-adapter.js`

Changes:

- Replace user-facing `side`/`sides` copy with `place`/`places`.
- Show affected place names from `placeName`.
- Adapt backend artifacts and analyses using `placeId`/`placeName`.

## Backend Implementation

Add a site settings handler, for example:

- `backend/src/handlers/site.js`
- `backend/src/handlers/site.test.js`

Wire routes in:

- `backend/src/lambda/api.js`
- `backend/scripts/local-api.mjs`
- `infra/modules/app/api.tf`
- `infra/modules/app/cloudfront.tf` if needed for route behavior

Update local seed data in `backend/scripts/lib/ensure-infra.mjs` to include a
site metadata record with seeded places for the local active test site.

Update check/artifact/analysis modules:

- `backend/src/handlers/checks.js`
- `backend/src/handlers/artifacts.js`
- `backend/src/handlers/description-validation.js`
- `backend/src/analysis/description-validator.js`
- `backend/src/workers/analyze-artifact.js`
- `backend/src/analysis/synthesize-check.js`

Persist and synthesize place metadata throughout the pipeline:

- Check header stores ordered `places`.
- Artifact item stores `placeId` and `placeName`.
- Queue message carries `placeId` and `placeName`.
- Analysis item stores `placeId` and `placeName`.
- Synthesis and guidance assessment source references can still use artifact IDs,
  but display metadata should be place-based.

## Documentation Updates

Update:

- `docs/dynamodb-data-model.md`
- `docs/architecture.md`
- Any ADR or runbook text that describes perimeter checks as fixed sides.

The documentation should describe:

- Site places configuration.
- Ordered places on check headers.
- Place-based artifact keys.
- Place metadata on artifacts and analyses.
- First-run setup gate.

## Test Plan

### Frontend Unit Tests

Update or add tests for:

- Site-code binding without place data.
- Site settings get/put helpers.
- Local site places persistence.
- Places setup with seeded places.
- Places setup with no seeded places.
- Add-place behavior and disabled add state.
- Save disabled until at least one non-empty place exists.
- Move up and move down reorders visible rows and saved payload order.
- Remove confirmation for existing named places.
- Blank-row remove without confirmation.
- Edit-mode back with no changes returns home.
- Edit-mode back with unsaved changes shows discard confirmation.
- Starting a perimeter check uses saved place order.
- Perimeter check copy uses place terminology.
- Submit payloads include `places`, `placeId`, and `placeName`.
- Results/review display place names.

### Backend Unit Tests

Update or add tests for:

- `GET /v1/site` returns site settings and places.
- `PUT /v1/site/places` validates and persists ordered places.
- Site-code response remains binding-only.
- `POST /v1/checks` accepts and stores `places`.
- Presign requires `placeId`, `placeName`, and supported content type.
- Presign S3 key uses `placeId`.
- Register artifact requires `placeId` and `placeName`.
- Queue message includes place metadata.
- Worker writes analysis with place metadata.
- Description validation uses the `/places/{placeId}` route and place context.
- Check detail returns place-based artifacts and analyses.

### End-To-End Manual Checks

Run the local app and verify:

1. Bind a device to a site with seeded places.
2. Confirm the seeded first-run copy and rows appear.
3. Reorder places and verify the visible order changes.
4. Remove a place and confirm the modal behavior.
5. Save and land on home.
6. Start a perimeter check and confirm the configured order is used.
7. Submit a check and confirm results show place names.
8. Open settings from home.
9. Make changes and back out; confirm the discard modal.
10. Bind or seed a site with no places and confirm the empty first-run copy and
    single empty input.

## Verification Commands

Run:

```bash
npm run test --workspaces --if-present
npm run typecheck --workspaces --if-present
npm run lint --workspaces --if-present
npm run build --workspaces --if-present
```

For frontend visual verification, also run the dev server and capture mobile and
desktop screenshots of:

- Empty first-run places setup.
- Seeded first-run places setup.
- Add-place state.
- Row menu open.
- Delete confirmation modal.
- Edit-mode unsaved discard modal.
- Perimeter check using place names.

## Implementation Sequence

Implement in one pass:

1. Add backend site settings `GET` and `PUT` routes.
2. Seed local site metadata and seeded places.
3. Rename backend check, artifact, validation, worker, and synthesis contracts
   from sides to places.
4. Add frontend site settings API helpers and local persistence helpers.
5. Add the places setup/edit custom element and templates.
6. Add routing and first-run gating.
7. Add the home settings icon button.
8. Refactor check session state from sides to places.
9. Update perimeter check, describe-instead, review, and results screens.
10. Update docs and tests.
11. Run automated verification.
12. Run visual/manual checks against the Figma states.
