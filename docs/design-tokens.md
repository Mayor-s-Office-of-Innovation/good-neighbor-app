# Design tokens — Figma ↔ code reference

**Status:** living reference · **Date:** 2026-09-14

The authoritative values live in the repo, not in Figma:

- [frontend/src/styles/tokens.css](../frontend/src/styles/tokens.css) — the app's
  semantic tokens (light in `:root`, dark under `html.wa-dark`). **These are the
  source of truth for anything we style ourselves.**
- [frontend/src/styles/wa-awesome.css](../frontend/src/styles/wa-awesome.css) — the
  vendored Web Awesome "Awesome" theme + Bright palette that wa-* components
  re-theme off.
- [frontend/design-system.html](../frontend/design-system.html) — the self-demonstrating
  visual reference (dev-only, `npm run dev:frontend`): every token rendered as a live
  swatch in light + dark, every button state, and the WA divergences as examples.

This doc records the values so Figma files can match what actually renders.

## Theme stack (one line each)

Enabled on `<html>` in [frontend/index.html](../frontend/index.html):

```
class="wa-light wa-theme-awesome wa-palette-bright wa-brand-blue"
```

| Layer | Choice | What it affects |
|---|---|---|
| Theme | `wa-theme-awesome` (vendored fork) | WA components' fonts, borders, shadows, spacing |
| Palette | `wa-palette-bright` | the 10-hue ramp behind every `--wa-color-*` |
| Variant | `wa-brand-blue` | maps WA's `brand` role to Bright's blue ramp |
| Scheme | `wa-light` / `wa-dark` (runtime toggle) | light/dark token swap for both layers |
| App tokens | `tokens.css` | everything we style ourselves |

| Layer | Choice |
|---|---|
| Theme | `wa-theme-awesome` |
| Palette | `wa-palette-bright` |
| Variant | `wa-brand-blue` |
| Scheme | `wa-light` / `wa-dark` (runtime toggle) |
| App tokens | `tokens.css` |



**Fonts:** no webfont ships (CDN-free requirement). Everything renders the system
sans stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`). Figma can
mock with Inter/SF, but know the shipped app uses system fonts. WA base size is
16px scaling on a 1.125 ratio; button labels are `font-weight: 700`.

## Semantic tokens (the app's palette — match these first)

| Token | Role | Light | Dark |
|---|---|---|---|
| `--bg` | page background | `#fafafa` | `#0f0f0f` |
| `--surface` | card / panel surface | `#ffffff` | `#1a1a1a` |
| `--surface-2` | subtle fill | `#f5f5f5` | `#242424` |
| `--surface-3` | grey pill fill | `#f0f0f0` | `#2a2a2a` |
| `--c-line` | hairline borders + dividers | `#e5e5e5` | `#333333` |
| `--text` | body text | `#171717` | `#ededed` |
| `--text-secondary` | secondary text | `#666666` | `#a8a8a8` |
| `--text-faint` | decorative-only text | `#767676` | `#8f8f8f` |
| `--brand-blue` | **the only chromatic accent** — links, status, active | `#155fce` | `#6ba7f0` |
| `--brand-blue-bg` | pale pill behind accent text/badges | `#e8f0fe` | `#17273d` |
| `--ink` | primary CTA pill fill | `#262626` | `#ededed` |
| `--on-ink` | primary CTA label | `#ffffff` | `#131313` |
| `--c-hazard` | severity reinforcement (always with label + icon) | `#b42318` | `#f2938a` |
| `--c-hazard-bg` | severity pill background | `#fdecea` | `#2a1614` |
| `--c-flag` | amber "you changed this" accent | `#b45309` | `#e8a54d` |
| `--toast-success` | toast success green | `#00883c` | `#6bdc94` |
| `--timeline-done-fill` / `--timeline-done-mark` | completed timeline node | `#000000` / `#ffffff` | `#ffffff` / `#000000` |

## Shape + elevation

| Token | Light | Dark |
|---|---|---|
| `--radius` | 12px | same |
| `--radius-sm` | 8px | same |
| `--radius-pill` | 999px (full pill) | same |
| `--shadow` | `0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1)` | same alphas, pure black |
| `--shadow-lift` | `0 4px 10px rgba(16,24,40,.1), 0 12px 24px rgba(16,24,40,.1)` | same alphas, pure black |
| `--toast-shadow` | `0 4px 4px rgba(0,0,0,.12)` | `0 4px 4px rgba(0,0,0,.4)` |

## Buttons (the ADR 0011 vocabulary)

| Class | Fill | Label | Shape |
|---|---|---|---|
| `.btn-ink` | `--ink` | `--on-ink` | pill (`--radius-pill`), min-height 46px, padding `0.7rem 2.3rem`, weight 700 |
| `.btn-outline` | transparent, 1px `--c-line` border | `--text` | same metrics |
| `.btn-blue` | `--brand-blue` | `--on-ink` | same metrics |
| `.btn-*-sm` | same fills | — | padding `0.45rem 1.2rem`, min-height 38px, 0.9rem, nowrap |
| `.login__link` | none (underline link) | `--text-secondary` | — |

Dark mode: `--ink` inverts to a **light** pill with dark label — mockups must show
that inversion, not a dark-on-dark pill.

Focus ring (all interactive elements): 2px solid `--brand-blue`, offset 2-3px.

## WA-layer values (only where wa-* components render)

Our app accent (`#155fce`) is deliberately **not** the same as the WA brand ramp —
don't average them in Figma. WA form controls (wa-input, wa-select, …) tint from
Bright's blue ramp:

| WA token | Value (Bright palette) |
|---|---|
| `--wa-color-brand-40` (WA's link/quiet accent) | `#235a96` |
| `--wa-color-brand-60` (focus ring) | `#4a99e4` |
| `--wa-color-neutral-95/90` (WA surfaces) | white / `#f0f0f0`-ish greys from Bright |

WA structural knobs from the Awesome theme (vendored): system font stack,
`--wa-font-size-scale: 1` (16px base, 1.125 ratio steps),
`--wa-border-radius-scale: 1.5` (s≈4.5px, m≈9px, l≈18px, pill 9999px), no hover
transform on buttons, hard offset shadows instead of soft ones. In practice our
native `.btn-*` pills use **our** tokens, so the WA knobs only matter when
mocking wa-input/wa-select/wa-callout etc.

## Rules the palette encodes (don't violate in Figma)

1. **Neutral system** — greyscale surfaces + text; `--brand-blue` is the *only*
   chromatic accent (links, status, active). Introducing new hues needs an ADR.
2. **Severity is never color-only** — hazard red always ships with a
   "Hazard" label + icon; the amber `--c-flag` always with "You marked this…"
   (WCAG 1.4.1).
3. **AA-checked pairs** (don't remix): `--text-secondary` ≥5:1 on every surface;
   `--brand-blue` 5.9:1 on white; `--ink`/`--on-ink` 15:1 (light) / 16:1 (dark);
   `--c-hazard` 5.9:1 on white. If a mockup puts these on new backgrounds,
   re-check contrast.
4. Dark mode is a **token swap** (same structure, different values) — one
   component set, two palettes; keep Figma variables structured the same way
   (light/dark collections bound to the same component styles).

## Reconciliation notes (2026-09-14)

- The app's own UI follows **tokens.css**; WA components follow the
  Awesome/Bright stack. The two agree on structure (greyscale + one blue) but
  not on the exact blue (`#155fce` vs `#235a96`). Figma: bind app-UI components
  to the semantic tokens; bind wa-* control mockups to the WA values.
- `--wa-form-control-*` values (WA form-control height/padding) are derived from
  font metrics (`round()` expressions) — see `wa-awesome.css` for the live
  expressions rather than hard-coding px in Figma.