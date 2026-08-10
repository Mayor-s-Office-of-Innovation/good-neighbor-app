---
name: dashboard-review
description: Audit an existing data dashboard, chart deck, or data visualization for accuracy, source integrity, denominator/population conflation, presentation simplicity, and neutral tone — then harden it before it is shared or published. Run this AFTER an initial dashboard/visualization has been built (not while scaffolding — use web-dev for that, which also covers accessibility). Triggers on requests like "review this dashboard," "is this chart honest/clear," "check the data and sources," "reduce cognitive load," "tighten before I share it." Produces a severity-ranked findings doc and applies fixes only on confirmation.
user-invocable: true
---

# Dashboard review

Harden an already-built data visualization before it is shared. The goal is a dashboard a skeptical, informed viewer can trust at a glance.

**Priority order — non-negotiable:** **accuracy first, clarity second, never reach for drama.** If a figure is not accurate *and* does not contribute to clear messaging, it does not belong — bias toward **removal**. Pairs with the `web-dev` skill (which governs *how* it's built); this skill governs whether what's built is *true, clear, and honestly framed*.

## Operating model

1. **Inventory first.** Enumerate every card/panel, every figure shown, every claim/headline, and every source link — and **flag every figure that has no source link** (that gap is itself a finding; see Dimension 4). You can't audit what you haven't listed.
2. **Audit across the dimensions below**, gathering findings — don't fix yet.
3. **Produce a severity-ranked findings doc** (see *Output*), each finding with: location, the problem, why it matters, and a proposed change. Rank by severity (accuracy > clarity), and within that by how badly it misleads.
4. **Discuss, then apply on confirmation.** Accuracy changes are high-stakes and often judgment calls — present findings and let the user decide. Do **not** silently rewrite numbers or claims. (Mechanical, unambiguous fixes like a dead link can be batched once confirmed.)
5. **Verify after applying** — rebuild, re-check that every shown figure still traces to a working source, and re-read the copy.

Scale effort to the ask: a quick "is this clear?" gets the high-confidence findings; "audit this before launch" gets all dimensions, with source figures re-verified against primary sources.

---

## The dimensions

### 1. Primary-source verification
- Trace **each figure to a primary source** — the original measurement, not an intermediary that compiled or re-stated it. If a fact sheet/article cites a dataset, go to the dataset.
- **Confirm the number actually matches** the source (open the PDF page, run the query, read the table). Don't trust that a cited number was transcribed correctly.
- Tag each figure with **source + year + denominator + measured-vs-modeled**. Flag modeled/estimated/"capture-recapture"/self-reported figures as such; never let a modeled split read as a hard count.
- When only an intermediary exists and it's privately circulated or copyrighted, **cite it by name but link the primary source** (and don't redistribute the intermediary).

### 2. Denominator & population integrity  *(the highest-yield check)*
- **Every funnel stage, ratio, and comparison must use ONE consistent population.** Walk each multi-stage visual: is stage 2 a true subset of stage 1, or a *different universe*?
- **Tell:** a big top-of-funnel number that's broader than what the lower stages can come from (e.g. "all drug users" → "opioid-Medi-Cal patients on medication"; "everyone in any care" → "the intensive tier"). The drop reads as attrition but is mostly *definitional* — that's a conflation. Start the funnel at the population the rest actually nests under, or drop the mismatched top entirely.
- **A ratio's numerator and denominator must be the same universe.** "X% retained" computed across two populations is misleading even when both numbers are real.
- **Never sum overlapping attributes** (someone can be unsheltered *and* using *and* mentally ill). Check nothing visually implies addition.
- If two panels measure genuinely different things, **don't force them into the same shape** to look symmetric — use the shape each one's data honestly supports (a funnel vs. a single stat).

### 3. Recency & internal consistency
- **Date-stamp every figure.** Flag mixed time-bases presented as comparable (e.g. a 2024 count next to a 2026 count, or an annual cohort vs. a point-in-time snapshot).
- **Cross-check the same metric everywhere it appears** — flag a value that differs between cards, between the dashboard and its spec, or between a figure and a footnote.
- For **live/changing data**, require an "as of <date>" and name the dataset + id.

### 4. Source-link coverage & hygiene  *(verifiability is a core deliverable)*
- **Every figure a skeptic might doubt exposes its own source link — to the *reader*, in the published view.** A figure with no way to check it is a finding in itself. **Default fix: ADD the link, don't cut the figure** — the bias-toward-removal default does *not* apply here. Reviewer-side verification (Dimension 1) is necessary but **not sufficient**: "I traced it to source" is not the same as "the reader can."
- **Gold standard — round-trip verifiability.** The link runs a live query that returns *the displayed number* (click "129,354" → the query returns 129,354). Freeze the exact window/filters into the URL so the count matches and doesn't drift. For derived or estimated figures that no single query reproduces, link to the **method** that produced them and label them as derived — don't fake an exact-match link.
- **Working & resolvable.** No local/relative file links that break when published; no links to files you can't redistribute; links open safely (new tab, `rel="noopener"`) and the label says *what* they source.
- **No dangling links (the other direction).** If you remove a stat, fix or remove the source label that cited it — and never leave a source link pointing at a figure that isn't shown.

### 5. Chart-type & encoding honesty
- **Match the visual to the data.** Pie/stacked charts imply a clean partition — wrong for overlapping attributes. Funnels imply nested subsets — only valid for true subsets. 
- No truncated or distorted axes, no 3D/area tricks; encoded length/width should be **proportional to the value**.

### 6. Headline–data fidelity
- **Each title/label accurately describes what's actually shown.** Flag a header that promises something the panel doesn't deliver (e.g. a title saying "how common" when only an overlap-within-a-subset is shown).
- **Each stat's referent is instantly legible** — a big number should say *what it counts* in prominent text, not bury it in a muted caption ("488 / **in Full Service Partnerships**", "437 / **on the shelter waitlist**").
- Define acronyms and avoid internal jargon ("persona-lens").

### 7. Tone — let the data speak for itself  *(preferred default)*
- Read every **header, summary/lede, kicker, and label** and ask: *is this making a dramatic claim, or stating the fact and letting the number carry it?* **Data-speaking-for-itself is the preferred state.**
- **Section titles must be descriptive, not editorial** — "What we are trying to provide," not "…and how little of it we provide."
- **Cut intensifiers and punch-lines** — "only," "just," "even," "almost no one," "a tiny fraction," "the system isn't delivering it." State the number and the standard ("an effective course runs ≥12 months; 210 remain at 6") instead of the editorial conclusion.
- Soften advocacy framing in callouts (e.g. "Evidence:" rather than "✔ It works!"). The throughline can still be pointed — it should emerge from the data, not from adjectives.

### 8. "Earn its place" test (cognitive load)
- For **every figure, caveat, and sentence, ask: does this add accuracy AND clarity?** If not, cut it. Bias toward removal.
- Kill **redundancy** — the same explanation stated twice, a number restated across cards, a cross-reference that invites a misleading mental calculation.
- Put each **caveat next to the figure it qualifies**; don't pool caveats far from their subject.

---

## Lighter appendix (check if time/scope allows)

- **Number formatting:** consistent thousands separators, rounding, and significant figures; `~` for estimates vs. exact counts; consistent units.
- **Link/asset health on publish:** no dead links, no references to removed files, build serves correctly under its final URL/base path.

---

## Output

Write findings to a markdown doc (e.g. `<name>-review.md`) the user can discuss against:

- A **ranked table**: `# | finding | dimension | severity | status`.
- For each finding: **location** (file:line / card), **the problem**, **why it misleads**, **proposed change**, and a **status** that updates as decisions are made (Agreed / Resolved / Deferred / Done).
- Record **resolved decisions and the reasoning** inline as you go (this becomes a durable rationale log — useful when someone later asks "why isn't X on here?").
- Keep the spec / source-of-truth doc in sync with applied changes.

## Reminders
- Don't change a number or claim without surfacing it first.
- Re-verify, don't assume — open the source, run the query, rebuild.
- Removing a figure is a valid and often correct outcome. The strongest dashboard is the one where every remaining number is true, sourced, and pulling its weight.
