# ADR 0014: Remove places — the perimeter check is a flat photo roll

## Status

Accepted (2026-09-21). Retires the per-site "places" setup and the place-by-place
capture timeline; no prior ADR covered them. Phase 1 (this decision) ships the
photo roll on top of one synthetic place; Phase 2 (a follow-up cleanup) flattens
the place layer out of the session shape and the artifact key.

## Context

Before a site could run its first perimeter check, an admin had to configure a
list of places ("Lobby", "Loading Dock", …) on a first-run setup screen that
gated every route. The capture screen then walked those places one at a time —
a timeline with expand/collapse, "Continue to X" / "Skip for now", a per-place
"Type instead" mode, an "Add place" dialog, and a Finish confirm that counted
places without evidence. This was the most complex part of the app and it added
friction for every site before any value was delivered.

Two field observations drove the change:

- **Setup friction.** Places had to exist before the first check, and the list
  rarely matched how staff actually walk a building.
- **Staff are sometimes unsafe taking photos.** Outside a building at night, or
  with people present, staff may not be able to point a camera at the problem. A
  written description was possible before, but only per place and as a
  supplement — it did not let a check finish on its own.

The analysis pipeline never needed places: every artifact is analyzed on its own
(ADR-free precedent — the single-issue `/problem` flow already ran the same
capture machinery on one synthetic place).

## Decision

- **Flat photo roll.** `/check` is one grid of photos for the whole perimeter.
  No places setup, no `/places/*` routes, no place timeline; a bound device
  lands straight on `/today`.
- **Completion rule: five photos, or one description.** A check is complete when
  `photoCount >= 5 || textCount >= 1`. One domain module owns the rule and its
  constants (`frontend/src/domain/check-completion.js`: `MIN_PERIMETER_PHOTOS =
  5`, `MIN_DESCRIPTION_LENGTH = 20`); the capture screen, the Finish button, and
  the tests all call it. Mixed evidence counts (two photos plus a description is
  complete, and the photos stay attached).
- **Text is a full alternative, not a supplement.** "Describe instead" saves one
  description per check (reopening edits it; saving a change replaces it). It
  registers as a text artifact through the existing `registerArtifact` path and
  is analyzed exactly like a photo, so a text-only check still produces task
  cards. The minimum length rises from 5 to 20 characters so a description is
  meaningful.
- **Client-side enforcement only.** Finish stays disabled until the rule is met;
  `completeCheck` records `photoCount`, `textCount`, and `evidenceKind`
  (`photos` | `description` | `mixed` | `none`) on the `CHECK#` header but
  never refuses. The background scorecard finalization re-runs on every home
  load until a completed header appears, so a server-side 409 on evidence
  grounds would loop forever.
- **Site name as `position_descriptor`.** The client sends the site name as
  `placeName` on every upload; the worker forwards it to the analyzer, falling
  back to the literal `"perimeter"` when absent. It is more useful on task
  cards and 311 escalations than a place name.
- **One synthetic place in Phase 1.** `startCheck` creates a single place
  (`PERIMETER_PLACE_ID = "perimeter"`, named after the site) so every code path
  keyed on `placeId + itemId` — analysis, result cards, deletion, answers,
  retry, the S3 key and the `ART#` sort key — keeps working unchanged. The
  backend makes `placeId` / `placeName` optional on presign and register
  (`DEFAULT_PLACE_ID = "perimeter"`), so the API is not coupled to the client
  change. Phase 2 flattens the session to `items[]` and drops `placeId` from
  the key.
- **No data migration.** `places` stays on existing `SITE#` items (unread), and
  old `ART#` rows keyed by real place ids stay readable — `getCheck` and
  `presignMedia` prefix-query the check and match on `artifactId`. In-progress
  drafts resume: the session normalizer keeps any pre-change places and drops
  the retired per-place fields.

Removed with this decision: `PUT /v1/site/places` (handler, local API, and the
`api.tf` route), the dead `.../description:validate` route, seeded places, the
`places-setup` component, and the per-place session mutations.

## Alternatives weighed

- **Keep places optional** (skip the gate, keep the timeline for sites that
  configure places): two capture UIs to maintain and test for one product; the
  timeline's complexity was the problem, not the gate alone.
- **Server-side enforcement** (409 from `completeCheck` below the threshold):
  rejected for the finalization loop above; a client that reaches Finish has
  already satisfied the rule, and a count the server can't refuse is still a
  count it can report.
- **Text as a supplement only** (description plus a lower photo minimum): does
  not solve the unsafe-to-photograph case, which needs zero photos to be a
  legitimate outcome.
- **Flatten the key in the same PR:** more surface in one change (S3 layout,
  keys, analytics columns, draft migration) for no user-visible gain; deferred
  to Phase 2 behind the synthetic place.

## Consequences

- Sites can run a check immediately after binding a device; a device that was
  parked on the places setup screen lands on home after the deploy with no
  action needed.
- `evidenceKind` on the header lets the compliance report show how often the
  text path is used. Text-only checks now carry whole runs through the analyzer,
  so the first week of `evidenceKind = description` results should be watched
  for empty or low-signal output.
- Task cards and 311 escalations label evidence with the site name instead of a
  place name; older rows keep their place names.
- The `<placeId>` segment of the artifact key and S3 path is a constant until
  Phase 2; new code must not read meaning into it.
- Removing a tile or the description drops it from the session only — an
  already-registered `ART#` stays on the backend, still counts toward the
  completion coverage gate, and is counted by `evidenceSummary`. There is no
  artifact delete route; an optional soft cap on photos per check (to bound
  analysis cost) is not required for Phase 1.
- E2E and unit suites that drove the places gate and `.place-row` selectors
  change in the same PR, or CI fails.
