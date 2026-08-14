# UI change — backend ramifications log

Running log of UI changes made by design, with any backend/API/database
follow-through they imply. For the development team to review.

## 2026-08-14 — Home: primary button copy

- **UI change:** "Start check" → "Start Perimeter Check" on the Today view
  primary button (`frontend/src/components/today-view.js`).
- **Backend ramifications:** None. Copy-only change; no API, data, or
  behavior impact.

## 2026-08-14 — Perimeter check: interactive prototype (design reference)

- **UI change:** Added `docs/prototypes/perimeter-check.html` — a
  self-contained, clickable prototype of the full perimeter-check flow in the
  chosen "Editorial" home direction. Open it in any browser. It demonstrates
  the intended interactions:
  - Home: last log = AI condition summary with date/time stamp + "Logged by"
    byline; "N days on record" mini bar chart; primary "Start check";
    secondary "Report a street issue".
  - Capture: numbered sides 1–4, forward-only stepper (covered / current /
    skipped states), multi-photo per side, **tap a thumbnail to delete it
    before submit** (pop-in / shrink-out animations), skip side, cancel →
    Home with a persist-and-resume card.
  - Review: multi-select condition tags + free-text note, then Submit.
  - Post-submit: brief "Summarising…" state, then Home updates with the new
    log and today's streak bar fills by thirds (3 checks/day).
- **Backend ramifications (for dev review; no action requested by design):**
  - Photos are held client-side until submit; deleting before submit implies
    no server-side delete is needed **if** uploads are deferred to submit.
    If photos stream up during capture instead, a delete endpoint (and
    orphan cleanup) is required.
  - Post-submit AI summarisation job producing a condition-only sentence,
    stored as the site's "last log" (fields: summary text, timestamp, shift
    attribution for the "Logged by X shift" byline).
  - Site-level "days on record" aggregate and per-day check count (0–3);
    the metric definition (what counts as a recorded day) needs a dev/design
    decision.
  - Check-draft persistence for the resume card on a shared device (local
    draft vs. server-side draft — matters for tablet swaps mid-check).
  - "Report a street issue" is a separate lightweight entity from checks
    (no streak credit, no sides); stubbed as a toast in the prototype.

## 2026-08-14 — Perimeter check prototype: streak/record removed for now

- **UI change:** Removed the "N days on record" bar chart from the prototype
  home (`docs/prototypes/perimeter-check.html`); "Report a street issue" is
  now a secondary pill button. The record/streak may return later.
- **Backend ramifications:** The days-on-record / per-day check-count
  aggregation noted above is **deferred** — no need to build it for this
  iteration. Everything else in the previous entry stands.
