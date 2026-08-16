# MVP Design Trim — Screen-by-Screen Plan

The product team delivered simplified designs for the MVP. Several "cool" features
built during the prototype phase need to come out. This doc tracks the trim
**screen by screen**: what the design shows, what we remove/change, the decisions
made, and anything tabled for later.

Tracked on the critical path as **"Trim the field-app screens to the product designs"**
in [MVP-TODO.md](./MVP-TODO.md) — this doc is the live screen-by-screen tracker for it.

Status legend: 🔲 planned · 🚧 in progress · ✅ done

---

## `/?demo=due` — Home, "check due" state ✅

Design reference: `~/Desktop/home-check-due.png`

Design shows (top → bottom): a neutral avatar circle + "Provider Name" / "Account ›"
subtitle · a `LAST LOG · YESTERDAY · 5:02PM` eyebrow · a large headline summarizing
the last log ("Trash at doorway — cleared by staff.") · whitespace · a full-width
dark **Start a perimeter check** button (camera icon) · a lighter **Document a
street issue** button.

### Decisions

- **Last log source:** the **most recent submitted check's worst finding** (real
  data — no new model). Headline = `<category> — <status>`, status via existing
  triage: hazard → `escalated to 311`, non-hazard rating ≥2 → `flagged to handle`,
  rating 1 → `noted, no action`. No findings on the last check → `All clear`.
  **No checks at all → `No activity recorded yet`** (no eyebrow).
- **Header icon:** neutral gray avatar circle (no photo/initials), replacing the
  location-pin marker. This is the **new global header** — the change propagates
  to every screen that uses `_siteHeader` (including the up-to-date view, 5b).
- **Report / "Document a street issue" button:** **tabled** — not built in this MVP.
- **Streak:** removed **everywhere** (there is no backend streak code — frontend only).

### Changes

**`frontend/src/components/today-view.js`**

1. `_siteHeader` — swap the location-pin for a neutral avatar circle; keep the site
   name; **delete the meta subline** (`No check yet today` / `Last check: …`) and its
   `timeOf` logic.
2. Hero → **Last log block**: eyebrow `LAST LOG · <RELATIVE DAY> · <TIME>`
   (TODAY/YESTERDAY/weekday from `submittedAt`) + the worst-finding headline described
   above. Removes the old "Perimeter status / Check due now / body / window-closes meta".
3. Delete the **streak sparkline**: `_sparkline()`, `_dayCounts()`, and the
   `streakDays` computation in `connectedCallback`.
4. Delete the **city-actions footer**: the `_footer()` call and the now-unused
   `_footer()` method (only the last-log + Start button remain).
5. **Start button** — move out of the hero to a **full-width, bottom-pinned ink
   button with a camera icon**, label `Start a perimeter check`, capped at the
   existing `.screen` phone width. Wire-up (`startCheck` → `/check`) unchanged.

**`frontend/src/styles/app.css`**

6. Remove the **streak CSS** (`.streakhead*`, `.spark*`) and the now-unused
   **`.cityfoot*`** rules. Add: neutral avatar-circle style, last-log eyebrow/headline
   styles, and the bottom-pinned full-width button layout.

**Comments / docs cleanup (streak "everywhere")**

7. Scrub streak/sparkline mentions in comments: `today-view.js` header ("decision #4"),
   `demo/seed.js`, `state/check-session.js`, `components/check-review.js`,
   `styles/tokens.css`, and the `streak sparkline` wording in `frontend/README.md`.

**Backend:** nothing — no streak code in `backend/`, `infra/`, or `spike/` (verified).

### Removed / tabled

- ❌ Streak sparkline + multi-day compliance viz (all frontend traces).
- ❌ "Window closes 7:00 PM · about 4 minutes" hero meta.
- ❌ Site-header meta line ("No check yet today" / "Last check: …").
- ❌ City-actions footer on this screen.
- ⏸️ "Document a street issue" button — tabled for a later MVP pass.

### Open decisions

- ~~Shared header scope~~ — **Resolved:** this is the new **global header**; the
  avatar + no-meta change propagates everywhere (`_siteHeader` is shared, incl. 5b).

### Addendum — Resume state (added when planning `/check`)

The `/check` screen gains Cancel → resume (see below), so the home due screen needs a
**Resume** affordance when an in-progress draft exists:

- Draft present → primary button becomes **"Resume perimeter check"**, plus a
  secondary text link **"Start over"** (discards the draft, then starts fresh).
- No draft → unchanged (**"Start a perimeter check"**).
- The last-log block is unchanged either way.

_To implement alongside the `/check` work (shared IndexedDB draft store)._

---

## `/check` — Perimeter check / capture (5c) ✅

> ⚠️ **Capture method superseded.** The live in-app `getUserMedia` viewfinder
> described in this section was built, then replaced by a **native camera handoff**
> — see [Capture method → native camera handoff](#capture-method--native-camera-handoff-supersedes-5c-live-viewfinder-) below for the why and the new screen shape. The
> rest of this section (top bar, progress pill, skip/resume/submit flow) still stands.

Design reference: `~/Desktop/Screenshot 2026-08-15 at 7.34.20 PM.png` (Side 2 of 4),
`…7.34.34 PM.png` (Side 3 of 4, showing a skipped side).

A camera-first, heavily simplified screen. Top bar: `‹ Cancel` · **Side N of 4**
(numbered, bold) · `Skip side`. A 4-segment pill progress bar. A large live
**Camera view**. Bottom row: a **thumbnail** (latest shot for this side, bottom-left)
· a circular **shutter** · `Next side ›`.

### Decisions

- **Camera:** **live in-app viewfinder** via `getUserMedia`, mirroring care-connect's
  `IdScanner.jsx` pattern (ported to our plain web-component style). Shutter draws the
  current video frame to a hidden `<canvas>` → **JPEG data-URL** (serializes cleanly to
  IndexedDB; matches the analyzer's base64 flow).
- **No camera / permission denied:** **hard error** (care-connect parity) — show
  "Could not access camera. Check permissions." + a Retry; **no file-picker fallback**.
- **Photos per side:** **multiple**. Thumbnail shows the latest + a count badge; **tap
  the thumbnail → a review sheet** listing this side's photos with per-photo delete.
- **Skip side:** marks the current side *skipped* (distinct state, dashed segment) and
  advances. **Total stays "of 4"** (skipped sides remain in the count). Walk is
  **forward-only** (no previous-side control).
- **Cancel:** leaves the check but **preserves the draft** (persisted to IndexedDB) so
  it can be resumed from home. No confirm dialog (nothing is discarded). Discard lives
  on home ("Start over").
- **Resume durability:** in-progress check **+ photo data-URLs persisted to IndexedDB**,
  surviving reload / app close.

### Progress-segment states

Solid black = captured (≥1 photo) · solid outline = current · **dashed outline =
skipped** · light gray = pending. No labels/compass names under the segments.

### Changes

**`frontend/src/db.js`**

1. Bump `DB_VERSION` → 3; add a **`draft`** store (single active in-progress check,
   photos inline as data-URLs). Helpers: `getDraft`, `saveDraft`, `clearDraft`.

**`frontend/src/state/check-session.js`**

2. Persist the in-progress check to the `draft` store (write on start / capture /
   skip / advance; clear on submit + cancel-discard). Add a per-side **`skipped`**
   state; keep a fixed **4 sides**, drop the applicable/N-A UI concept. Items become
   **photo-only**, `{ kind: "photo", dataUrl }` (was `thumbUrl` object-URL).
3. On boot / home, expose whether a resumable draft exists.

**`frontend/src/components/perimeter-check.js` + `.templates.js`**

4. Rewrite to the camera-first layout: 3-column top bar (Cancel / "Side N of 4" /
   Skip side), the 4-segment pill stepper, a live `<video>` viewfinder + hidden
   `<canvas>`, and the bottom thumbnail / shutter / Next-side row.
5. Camera controller: `startCamera()` / `stopCamera()` (`facingMode: "environment"`),
   `capture()` → canvas → data-URL → append photo to the current side; **hard-error
   overlay** + Retry on permission failure. Stop the stream on Cancel / submit / leave;
   keep it live across sides.
6. Thumbnail tap → **review sheet** (this side's photos, delete each).
7. **Next side** advances by raw index; on the **last side** the forward button
   becomes **"Submit check"** → `submitCheck()` → Summarising… → `/results` (see the
   Submit section below; `/review` is skipped). **Skip side** → mark skipped, advance.
   **Cancel** → stop camera, `/today` (draft kept).

**`frontend/src/main.js`**

8. Drop the `capture-audio` import (voice gone) and the `capture-photo` import (the live
   viewfinder replaces it). `transcribe.js`, `capture-audio.js`, `capture-photo.js`
   become unused — delete or leave dormant.

**`frontend/src/styles/app.css`**

9. Replace the `.view-check` capture styles: remove `.capture*`, `.note-composer*`,
   `.sideitem*`, `.uploadbar*`, the column `.step*`/`.viewfinder*` (card/guidance/gps).
   Add: 3-column check top bar (scoped, `.topbar` is shared with 5d/5e), pill stepper
   with the four states, full-bleed video viewfinder, shutter, thumbnail + count badge,
   camera-error overlay, and the review sheet.

### Removed / tabled

- ❌ Voice capture (tile + `capture-audio` + `transcribe`) and Note capture (tile +
  composer).
- ❌ Compass side names (North/East/South/West) in the UI → "Side N of 4".
- ❌ Per-side item list + per-item Remove, the "Uploading… analyzed as you go" bar.
- ❌ Topbar title/subtitle, the "GPS locked" chip, per-side guidance text, the
  "Offline? Queued until signal." / "Can't cover this side" footer.

### Downstream ripple (later screens — flagged, not touched now)

Voice/note item kinds and compass side-names still appear in `check-review.js` (5d),
`check-results.js` (5e), `domain/findings.js`, `services/analyzer.js`, and `demo/seed.js`.
Capture will stop **producing** voice/note and stop **showing** compass names; those
screens (and the demo seed) will show stale voice/note/compass until their own passes.

### Open decisions

- ~~Last-side CTA label~~ — **Resolved:** the last side submits directly (**"Submit
  check"**), skipping `/review`. See the Submit section below.

---

## Submit + AI summary — post-capture (replaces 5d review) ✅

Design reference: `~/Desktop/Screenshot 2026-08-15 at 7.51.18 PM.png` (the new "Anything
to add?" chips + notes screen — **deferred**), `…7.51.23 PM.png` (the "Summarising…" AI
loading state — **building the cheap version**).

The real design flow is: capture all sides → **"Anything to add?"** (quick-tag chips +
notes → Submit check) → **"Summarising…"** → results (5e). Path of least resistance for
now (**Option 1**): submit straight after the last side, skip the coverage-ledger review
**and** the chips screen, but keep a cheap Summarising… transition.

### Decisions

- **Submit after the last side:** no coverage-ledger review (5d) in the flow.
- **Extract `submitCheck()`** (new `frontend/src/services/submit-check.js`) from
  `check-review._submit` — `analyzeCheck(items)` → `scorecardToFindings` →
  `markSubmitted` → `addCheck` → clear draft. Returns the persisted check; the caller
  navigates. Reusable by the chips screen when it lands.
- **"Summarising…" state:** a centered `✦ AI SUMMARY / Summarising…` card shown while
  the (mock, instant) analyzer runs, then → `/results`. Pure polish for now.
- **Chips + notes screen: deferred.** Notes/quick-tags aren't collected yet; findings
  come from photo analysis. _Note: the chip vocabulary (Trash, Needles, Graffiti, Tents,
  Drug use…) maps onto the analyzer's finding categories — natural to wire later._

### Changes

1. **New `services/submit-check.js`** — the extracted, photo-only `submitCheck()`
   (items carry `dataUrl`; persisted `sides` summary reflects the skip state, no N/A).
2. **`perimeter-check.js`** — last-side "Submit check" calls `submitCheck()`, shows the
   Summarising… state, then `/results`.
3. **Summarising… state** — either a lightweight `/summarising` route or an in-place
   overlay in `perimeter-check` during submit (decide at build; overlay is simplest).
4. **Retire `/review` from the flow** — leave `check-review.js` + route dormant for now
   (revisit when the chips screen replaces it); nothing navigates to it.

### Removed / tabled / deferred

- ⏸️ **"Anything to add?" chips + notes screen** — deferred (likely to change).
- ❌ Coverage-ledger review (5d) removed from the flow (file left dormant).

### Downstream ripple

`check-review.js` becomes unreachable but still references compass names + voice/note
(harmless while dormant). When the chips screen replaces it, `submitCheck()` is already
the shared seam to file the check.

---

## Implementation notes (as built) ✅

Built in four stages; `lint` / `typecheck` / `build` all green.

- **db.js v3** — added the out-of-line `draft` store (`getDraft`/`saveDraft`/`clearDraft`),
  key `"current"`, photos inline as data-URLs.
- **check-session.js** — fixed 4 sides, per-side `{ items, skipped }`; mirrors every
  mutation to the draft store; `loadDraft()` hydrates after reload; `clearCheck()` drops
  both memory + draft. The item API stays **kind-agnostic** (voice/note plumbing left
  intact but unused) — per the "removal is visual only" call.
- **perimeter-check.js/.templates.js** — full rewrite: live `getUserMedia` viewfinder,
  hidden `<canvas>` → JPEG data-URL shutter, 4-segment pill, hard-error overlay + Retry,
  thumbnail + count → review sheet with per-photo delete, Skip, and last-side "Submit
  check". Next is disabled until the side has a photo (Skip covers the empty path).
- **services/submit-check.js** — extracted from `check-review._submit`; on submit it
  clears the **draft** but keeps the in-memory session so 5e can read the just-submitted
  photos, then results clears the session on exit (unchanged).
- **today-view.js** — draft present → "Resume perimeter check" + "Start over" link.

Deviations from the plan above:

- **main.js imports left as-is.** The plan said drop the `capture-photo`/`capture-audio`
  imports; per "removal is visual only, leave the support code alone" they stay
  registered-but-unused (as do `capture-*.js` and `transcribe.js`). Zero visual impact.
- **CSS reuse over new route for Summarising.** Implemented as an in-place fixed overlay
  in `perimeter-check` (no `/summarising` route) — simplest, as flagged.
- **check-results thumbnails** now read `dataUrl` (were `thumbUrl`) so the live
  submit→results flow shows real photos. The stale voice/note **copy** on 5e is left for
  that screen's own pass.

---

## Capture method → native camera handoff (supersedes 5c live viewfinder) ✅

The 5c screen shipped with a live in-app viewfinder (`getUserMedia` → `<canvas>` →
JPEG data-URL). Field-testing the enlarged camera surfaced why that approach is wrong
for this product: **we're asking people to photograph streets, and a hand-rolled
viewfinder can't give them the camera features they already expect.** Switching to a
**native camera handoff** (`<input type="file" accept="image/*" capture="environment">`).

### Why switch (rationale)

- **No zoom / focus / flash.** A live `getUserMedia` feed exposes zoom, tap-to-focus,
  torch, and lens-switching only through spotty, build-it-yourself constraint APIs —
  decent on Android Chrome, **largely absent on iOS Safari and desktop**. Street shots
  routinely need to zoom across a road or focus on one object; we can't reliably offer
  that ourselves.
- **Native camera is free and better.** The `capture` file input hands off to the
  phone's own camera app, so users inherit **everything the device offers** — optical +
  pinch zoom, tap-to-focus, HDR, flash, ultra-wide/tele lenses, night mode — at full
  quality, with far less code for us to own.
- **Fixes a WYSIWYG bug.** The viewfinder previewed with `object-fit: cover` (cropped)
  but captured the *full* video frame — the saved photo showed more than the framing.
  With native capture, the preview **is** the captured image; the mismatch disappears.
- **Trade-offs accepted:** we lose in-app framing overlays ("line side 2 up here") and
  the branded live-capture flow, and the capture UX becomes a modal OS handoff. For
  street photography, camera capability outweighs a bespoke viewfinder.

### Why a live viewfinder can't fix this — the lens problem

The strongest evidence is the sibling **street-conditions** app (`../street-conditions`,
`src/components/CameraView.jsx`), which is live and solves capture with a `getUserMedia`
viewfinder (via `react-webcam`) — the approach we rejected. It tries *hard* to give users
zoom, and the way it still fails is exactly why we're switching. Field-testing it, you
**can't zoom out** to a wide shot. Two zoom modes, neither reaches a wide framing:

- **Hardware zoom** (`track.applyConstraints({ advanced: [{ zoom }] })`, when
  `getCapabilities().zoom` exists): the rear camera's `zoom.min` is essentially always
  **1.0**. The **0.5× "ultra-wide" is a physically separate camera**, not a zoom-out of
  the main sensor — the native camera app *switches lenses* to get it. A `getUserMedia`
  stream bound to one camera can only zoom **in** from 1.0; it can't get wider than the
  main lens's field of view. (Their code even hopes to "start at the widest… often 0.5x
  on mobile" — but `minZoom` is 1 on real devices.)
- **Digital zoom** (the fallback, and what **iOS Safari always uses** because it doesn't
  support the `zoom` capability at all): pure `transform: scale()` + a center-crop in
  canvas, clamped to min 1 — it only **crops in**, degrading quality, and zoom-out is
  impossible by construction.

So a live viewfinder's floor is the main lens's FOV, and reaching the other physical
lenses (ultra-wide/tele) via web APIs is unreliable-to-impossible, worst on iOS. The
**native camera app owns lens switching**, so the handoff gives users real 0.5× ultra-
wide, optical zoom, tap-to-focus, and flash for free — the capability the viewfinder
fundamentally can't provide. (Notably, street-conditions already *has* the file-input
path, but only as an "Upload" fallback with no `capture` — we promote that mechanism to
the primary path and point it at the camera.)

### Decisions

1. **`capture="environment"`** — open straight to the rear camera, no library chooser.
   Keep it simple for now (revisit letting users pick existing photos post-MVP).
2. **Desktop = file picker.** The `capture` attribute is ignored on desktop, so laptops
   get a native file-open dialog (choose an existing image). Acceptable — real users are
   on phones; we do **not** keep the old viewfinder as a desktop fallback.
3. **Inline grid review + delete.** Shots for the current side render as a thumbnail
   grid with per-tile delete; the separate bottom **review sheet is dropped**.
4. **Empty state (concise):** a single centered **＋ "Add photo"** tile with one muted
   line — _"Tap to open your camera"_. Once ≥1 photo exists, the grid shows the
   thumbnails followed by a smaller trailing ＋ tile; no helper line.

### Per-device behavior

| | Behavior |
|---|---|
| **Phone** (iOS Safari / Android Chrome) | Opens native rear camera; full zoom/focus/flash/lens. Native Retake/Use confirm. **One photo per tap** (`multiple` ignored with `capture`); tap ＋ again for more. |
| **Tablet** | Same as phone. |
| **Laptop / desktop** | `capture` ignored → native **file picker**; user selects an existing image. No live webcam. |

### Screen changes (`/check`)

The live feed leaves our app, so the **viewfinder + shutter concept is removed** and
5c becomes a **per-side photo checklist**:

```
‹ Cancel     Side 2 of 4     Skip side
▬▬▬▬  ▬▬▬▬  ▬▬▬▬  ▬▬▬▬
┌───────────────────────┐
│  [shot]  [shot]        │   thumbnails of this side's shots
│  [ ＋ ]                 │   ＋ tile → opens native camera
└───────────────────────┘   (empty: centered ＋ "Add photo" +
        Next side ›            "Tap to open your camera")
```

**`frontend/src/components/perimeter-check.js` + `.templates.js`**

1. Remove the live-camera controller (`_startCamera`/`_stopCamera`/`_capture`), the
   `<video>`/`<canvas>`, the shutter, and the camera-error/Retry overlay.
2. Add a hidden `<input type="file" accept="image/*" capture="environment">`; an
   ＋ "Add photo" tile/button triggers it. On `change`, read the file via `FileReader`
   → JPEG **data-URL** → `addItem(side, { kind: "photo", dataUrl })` — **the storage +
   submit pipeline is unchanged** (same data-URL the analyzer/base64 flow already uses).
3. Replace the shot strip + review sheet with an **inline thumbnail grid** with per-tile
   delete (`removeItem`).
4. **Kept as-is:** top bar (Cancel / Side N of 4 / Skip), the 4-segment pill, Next side /
   Submit check, resume-from-draft, and the Summarising… → `/results` handoff.

**`frontend/src/styles/app.css`**

5. Remove `.camera*`, `.camera__video`, `.camera__error*`, `.shutter*`, `.shotstrip`/
   `.shot`, and `.sheet*` (review sheet retired). Add: photo-grid, add-photo/＋ tile,
   empty-state, and grid-tile delete styles. The full-height flex column stays (grid
   fills the space the viewfinder used to).

### Removed / tabled

- ❌ Live `getUserMedia` viewfinder, `<canvas>` shutter capture, camera-error + Retry,
  the `object-fit: cover` preview crop, and the bottom review sheet.
- ❌ In-app framing overlays (already out of scope).
- ⏸️ Letting users pick an **existing** library photo (no `capture`) — tabled; revisit
  post-MVP.
- ⏸️ Desktop `getUserMedia` fallback for demos — not built.

### Downstream ripple

Minimal. Acquisition changes; **persistence and submit do not** — items still carry
`{ kind: "photo", dataUrl }`, so `submit-check.js`, `check-results.js` evidence, and the
analyzer flow are untouched. Voice/note plumbing remains dormant (unchanged).

### Implementation notes (as built)

`lint` / `typecheck` / `build` all green.

- **perimeter-check.templates.js** — dropped the `<video>`/`<canvas>`/shutter/error
  overlay/review sheet. Shell now has a `#shotgrid`, a hidden
  `<input type="file" accept="image/*" capture="environment">`, and a bottom
  `.check__actions` row with the full-width Next / Submit button. New `shotTile`
  (photo + delete) and `addTile(empty)` (＋ tile; larger with the "Tap to open your
  camera" hint when the side is empty) templates. Add tile uses the `camera` icon.
- **perimeter-check.js** — removed the whole `getUserMedia` controller. ＋ tile clicks
  the hidden input; on `change`, `FileReader.readAsDataURL` → `addItem(side, { kind:
  "photo", dataUrl })`. Add + per-tile delete are **delegated** on `#shotgrid` (the grid
  re-renders each change). `_renderShots()` renders `shots + addTile`, toggling
  `.shotgrid--empty`. Top bar, pill, Skip, Next/Submit, resume-draft, and Summarising… →
  `/results` all unchanged. (`disconnectedCallback`/stop-camera gone — no live stream.)
- **app.css** — removed `.camera*`, `.shutter*`, the old `.shotstrip`/`.shot` strip, and
  all `.sheet*`. Added `.shotgrid` (flex-grow grid, scrolls), `.shotgrid--empty`
  (centers the lone tile), `.shot`/`.shot__img`/`.shot__del`, `.addshot` +
  `.addshot--empty` + `.addshot__icon/label/hint`, and a full-width `.check__actions` /
  `.check__next`. The full-height flex column stays; the grid fills the freed space.

Deviations from the plan above:

- **Bottom action = full-width button.** With no shutter to center, Next / Submit is a
  single full-width ink button (cleaner than pinning it beside an absent shutter).
- **`capture-photo.js` left dormant.** It's a pre-existing WA-styled native-capture
  component; unrelated to this screen and untouched (voice/note plumbing convention).

### Candidate enhancements (post-MVP)

Nice touches observed in **street-conditions**' `CameraView.jsx` that would fit our flow
later (not built now):

- **Low-quality / blur detection.** Their `detectLowQualityPhoto()` samples a small
  luminance grid and measures brightness variance + edge contrast to flag underexposed or
  blurry shots ("may lead to unreliable AI scoring"), badging the thumbnail. Since our
  photos also feed an analyzer, this is a smart guardrail — and it runs on any JPEG
  data-URL, so it drops into `_onFilePicked` regardless of capture method. Would pair well
  with a per-shot warning badge in the grid.
- **Tap-thumbnail → full-size preview.** They open a tapped shot in a full-screen modal
  (with the low-quality warning inline). We currently only support delete on a grid tile;
  a tap-to-view-large affordance is cheap and helps users vet a shot before moving on.

---

## Remaining trim work 🔲

**Done so far:** Home "check due" (5a) · `/check` capture (5c) incl. the native-camera
handoff · Submit → Summarising → results flow.

The capture rewrite deliberately stopped **producing** voice/note items and compass
side-names, but those still **appear** on downstream screens and in the demo/analyzer
data. Each is its own screen-by-screen pass (discuss → plan here → implement on "go"):

1. **`/results` (5e), `check-results.js`** — remove the stale "Photos, voice, and notes
   were all read." copy (in `_summary`) and the voice/notes counts in `_evidence`;
   photo-only. The live submit→results path already reads `dataUrl` thumbnails.
2. **`demo/seed.js`** — seeded checks still use `applicable`/compass side-names and
   voice/note item kinds; reshape to photo-only, `{ items, skipped }`, numbered sides so
   the demo matches the new model (Home last-log + results read this).
3. **`domain/findings.js` + `services/analyzer.js`** — still reference voice/note item
   kinds, `sourceKind`, and compass `side` names in finding provenance. Decide what
   provenance means photo-only.
4. **`check-review.js` (5d)** — dormant/unreachable (nothing routes to it) but still
   references compass + voice/note. Decide: keep dormant vs delete. `submitCheck()` is
   already the shared filing seam if the "Anything to add?" chips screen later replaces it.

**Not yet planned:** the up-to-date Home state (`/?demo=uptodate`, 5b) and onboarding.

**Post-MVP capture enhancements** (blur/low-quality detection, tap-thumbnail preview) are
noted under [Candidate enhancements](#candidate-enhancements-post-mvp).
