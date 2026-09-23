# ADR 0014: Remove places — the perimeter check is a flat photo roll

## Status

Accepted (2026-09-21). Retires the per-site "places" setup and the place-by-place
capture timeline; no prior ADR covered them. Phase 1 shipped the photo roll on
top of one synthetic place; Phase 2 (same day, follow-up PR) flattened the
place layer out of the session shape, the API, the artifact key, the S3 key,
the analyze worker, and the analytics columns. The consequences below describe
the built state after both phases.

The original five-photo minimum recorded below was reduced to three photos on
2026-09-23; `frontend/src/domain/check-completion.js` owns the current rule.

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
- **A fixed `position_descriptor`.** The analyzer requires one; the check has
  no per-photo position, and nothing downstream decides on the value (it is
  echoed onto tasks as `source.positionDescriptor` and read only as a card
  caption fallback, which Phase 2 removed). The worker sends the literal
  `"perimeter"` for every artifact. Phase 1 briefly sent the site name via a
  `placeName` field; Phase 2 dropped the field rather than add a site lookup
  to the worker for a value nobody consumes.
- **Flat session and flat keys.** The session is `check.items[]` and every
  mutation takes an item id. The artifact key is `CHECK#<checkId>#ART#<artifactId>`
  and the S3 key is `checks/<siteId>/<checkId>/<artifactId>`. Presign and
  register accept only the fields they store; legacy `placeId` / `placeName`
  from a pre-Phase-2 client are ignored, never rejected. Evidence cards are
  captioned with the bound site's name from local storage.
- **No data migration.** `places` stays on existing `SITE#` items (unread).
  `ART#` rows and S3 objects written with a `<placeId>` segment stay readable:
  every reader prefix-queries `CHECK#<checkId>#ART#` and matches on the
  `artifactId` attribute, and nothing rebuilds a key from parts. In-progress
  drafts and review records resume: the session normalizer flattens a
  pre-Phase-2 `places` map into `items[]` on load (place order, then capture
  order) and keeps each item's own fields, so an old item's place name still
  captions its card.

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
- Task cards caption evidence with the site name; rows written before the
  change keep their place names. `source.positionDescriptor` on new tasks is
  the literal `"perimeter"` and must not be treated as a location.
- The analytics `artifacts` entity no longer exports `placeId` / `placeName`;
  older Parquet files keep the columns and `union_by_name` fills them as NULL.
- Removing the saved description, or an evidence card, deletes its registered
  `ART#` through `DELETE /v1/checks/{checkId}/artifacts/{artifactId}` so a
  stale artifact never reaches the scorecard fold; removing a photo tile drops
  it from the session only. An optional soft cap on photos per check (to bound
  analysis cost) is not required.
- E2E and unit suites that drove the places gate and `.place-row` selectors
  change in the same PR, or CI fails.
