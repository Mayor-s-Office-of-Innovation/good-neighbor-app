# Frontend design system — building screens to spec

**Status:** living reference · **Date:** 2026-08-12

A practical guide to building a new screen that **matches the app's look without a mockup**.
The design was ported from the wireframes into a small, reusable class + token system; this
doc names those pieces so you compose from them instead of inventing per-screen styles.

**Source of truth (read the code, this doc points at it):**

- [frontend/src/styles/tokens.css](../frontend/src/styles/tokens.css) — every color, radius,
  and shadow, plus the light/dark values. **Never hard-code a hex; always use a token.**
- [frontend/src/styles/app.css](../frontend/src/styles/app.css) — the component classes below,
  grouped by screen with comments.
- Worked example: [site-setup.templates.js](../frontend/src/components/site-setup.templates.js)
  (onboarding) and [today-view.js](../frontend/src/components/today-view.js) (home hub).

---

## The system in one paragraph

**Neutral greyscale surfaces + text, with one blue accent** (`--brand-blue`) reserved for
links, status, and active states. **Severity/status is never carried by color alone** — grouping
and a text label lead, color only reinforces (WCAG 1.4.1). **Dark mode** is a token swap: light
values live in `:root`, dark overrides in `html.wa-dark`. Web Awesome (WA) components re-theme
off the same `.wa-dark`/`.wa-light` class, so one toggle re-themes our CSS and WA together.
Because `app.css` is **unlayered** it beats WA's `@layer` styles — that's why our `.btn-ink`
can fully own a native `<button>`'s box (see the comment above `.btn-ink`).

## Tokens you'll use most (from tokens.css)

| Token | Role |
|---|---|
| `--bg` / `--surface` / `--surface-2` / `--surface-3` | page bg / card / subtle fill / grey pill |
| `--c-line` | hairline borders + dividers |
| `--text` / `--text-secondary` / `--text-faint` | body / secondary / decorative-only text |
| `--brand-blue` / `--brand-blue-bg` | the only chromatic accent (links, one status, active) |
| `--ink` / `--on-ink` | the primary CTA pill fill + label (inverts in dark) |
| `--c-hazard` / `--c-hazard-bg` | severity **reinforcement** (always with a "Hazard" label + icon) |
| `--radius` `--radius-sm` `--radius-pill` · `--shadow` `--shadow-lift` | shape + elevation |

## Layout: pick one of two screen archetypes

**A. Home-hub card** — a bordered, rounded card of hairline-divided sections. Use for hubs and
dashboards (today-view, onboarding).

```html
<div class="home">           <!-- centers, max 440px -->
  <div class="screen">       <!-- surface card, 20px radius, shadow -->
    <div class="screen__sec …">…</div>   <!-- padded section; + section => top hairline -->
    <div class="screen__sec …">…</div>
  </div>
</div>
```

**B. Flow column** — a centered column with a back-button top bar. Use for linear/task screens
(the capture → review → results check flow).

```html
<div class="flow">           <!-- centers, max 460px -->
  <header class="topbar">
    <button class="topbar__back">…</button>
    <div class="topbar__titles">
      <h1 class="topbar__title">…</h1><p class="topbar__sub">…</p>
    </div>
    <span class="topbar__meta">…</span>
  </header>
  …
</div>
```

## Headers

- **`.sitehead`** — round pin marker + name + meta line. The identity header on hub screens.
- **`.hero`** — centered `hero__eyebrow` / `hero__headline` (big) / `hero__body` / `hero__meta`.
  The status/heading block inside a `.screen` card.
- **`.flow-hero`** — the flow-column equivalent (eyebrow / headline / body).
- **`.topbar`** — back button + titles + right-aligned meta, for flow screens.

## Buttons — always native `<button>` + a class, never `wa-button` for a primary CTA

- **`.btn-ink`** — the primary action pill (charcoal `--ink`, white label; inverts in dark).
- **`.btn-outline`** — the secondary sibling (hairline border, transparent).
- **`.btn-ink--sm` / `.btn-outline--sm`** — compact, for in-card action rows.

```html
<button class="btn-ink" type="button">Primary action</button>
<button class="btn-outline" type="button">Secondary</button>
```

Buttons are inline pills by default. Full-width is a per-screen choice (e.g. setup scopes
`.setup .btn-ink { width: 100% }`) — don't make it global.

## Surfaces, text, status

- **`.card`** — a generic surface (lighter than `.screen`); **`.stack`** / **`.stack--tight`**
  for vertical rhythm (flex column, 1rem / 0.5rem gap).
- **`.hint`** — muted helper text; **`.eyebrow`** — small label above a heading.
- **`.pill` + `.pill--route|pending|confirm`** — status chips; **`.legend` / `.legend__dot--*`**
  — chart legends. Every status pill/dot is **paired with its word** — color never stands alone.

## Forms

Form controls are **Web Awesome** components (`wa-input`, `wa-select`, `wa-textarea`,
`wa-checkbox`, `wa-callout`, `wa-spinner`). They theme off the `--wa-*` tokens and the
`.wa-dark`/`.wa-light` class, so there's little to style yourself — drop them into a
`.screen__sec` (often a `.stack`) and let them theme. Use a native `<button class="btn-ink">`
for the submit, not a WA button.

## Non-negotiable rules

1. **Tokens only** — no raw hex/rgb in component CSS, so dark mode stays correct.
2. **Color never the sole carrier** of meaning (WCAG 1.4.1) — pair with a label/icon/shape.
3. **44px minimum touch targets** for interactive elements (WCAG 2.2 AA, 2.5.8).
4. **`text-wrap: balance`** on headlines (already in `.hero__headline` etc.).
5. **Match, don't add** — reach for an existing class first; only add CSS when the system
   genuinely lacks the piece, and add it as a reusable rule, not a one-off.

## Recipe: a new screen with no mockup

1. **Archetype** — hub/dashboard → hub-card (A); linear task → flow-column (B).
2. **Header** — hub → `.sitehead` and/or a `.hero`; flow → `.topbar` (+ `.flow-hero` if needed).
3. **Sections** — one `.screen__sec` per logical block (hub) or stacked blocks (flow); dividers
   come free between adjacent `.screen__sec`.
4. **Primary action** — one `.btn-ink`; secondaries are `.btn-outline`.
5. **Status/severity** — a `.pill` or `.legend` **with text**; pull the color from a token.
6. **Forms** — WA controls in a `.stack`; native `.btn-ink` submit.
7. **Check** — keyboard-reachable, 44px targets, and toggle `.wa-dark` to confirm it holds.

## Worked example — the onboarding screen

[site-setup.templates.js](../frontend/src/components/site-setup.templates.js) is built entirely
from the pieces above and adds **no new visual vocabulary**: hub-card archetype (`.home` >
`.screen` > `.screen__sec`), a brand `.sitehead`, a `.hero` heading, `.btn-ink`/`.btn-outline`
actions, and WA controls for the code field. The only setup-specific CSS is full-width CTAs and
the "Don't have a code?" disclosure (`app.css`, "First-run setup"). That's the target shape for
a screen matched to the design without a mockup.
