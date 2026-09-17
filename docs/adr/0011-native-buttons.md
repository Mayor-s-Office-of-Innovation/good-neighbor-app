# ADR 0011: Native buttons; trimmed Web Awesome surface

## Status

Accepted (2026-09-14). Refines the Web Awesome adoption in ADR 0001: buttons
are carved out of the component-library choice.

## Context

The app shipped two button vocabularies: 76 native `<button class="btn-*">` and
9 `<wa-button>` (both cancel/opt sheets, and 5 in the dev-only guidance harness).
The design system already mandated native buttons for primary CTAs and form
submits. The wa-buttons that remained were mostly fully restyled via
`::part(button)` (the sheet cancel/opt buttons), and wa-button's signature
stateful feature (`loading`) was used zero times.

Web Awesome's `native.css` (pulled in via `webawesome.css`) also restyles every
*native* button/inputs with WA's form-control box, which our unlayered `app.css`
button classes had to fight and reset ("Undo WA's native-button box" — `.btn-ink`).

A bundle probe (esbuild closure of the import graph) showed dropping
`button.js` alone saves ~nothing: `select.js` imports the button chunk itself
and renders `<wa-button>` internally. The only `<wa-select>` in the app is the
dev harness, which is DEV-gated (dynamic import) — but the blanket static
imports of `select.js`/`option.js` in `main.js` shipped that whole graph to
production anyway.

## Decision

- **All buttons are native `<button>` + a token-built `.btn-*` class.**
  `<wa-button>` is dropped: the 9 call sites are migrated, and
  `components/button/button.js` is no longer imported.
- The select/option static imports move out of `main.js` into the dev harness
  (their only consumer), so the button chunk + select graph drop out of the
  production bundle automatically (~24 KB gzip of the WA graph, measured).
- We own the loading pattern: `button[data-loading]` + `wa-spinner`.
- The unused default WA theme (`webawesome.css` → `themes/default.css`) is
  replaced by direct imports of the layers/utilities/theme files we actually use.

## Consequences

- One button vocabulary: `.btn-ink` / `.btn-outline` / `.btn-blue` (+ `--sm`
  variants), documented in docs/frontend-design-system.md.
- Bundle: ~−3 KB gzip CSS (default theme) plus ~−24 KB gzip JS (select+button
  graph no longer ships). Buttons themselves cost ~nothing; the win came from
  untangling select's dependency on the button chunk.
- If a genuinely stateful button need appears (e.g. width-pinned async submit
  UX that our loading pattern can't cover), revisit.
- wa-select/wa-option remain approved form controls for future screens — this
  ADR only moves their *imports* to the consumer that uses them.