# Plan: page transition animations (View Transitions API)

Status: **proposed** — not started. Scope agreed: **Phase 0 + 1** (baseline
crossfade + directional slides). Phase 2 (shared-element morphs) deferred.
Date: 2026-08-14

Add native-feeling animated transitions between the four flow screens using the
web platform's same-document **View Transitions API** (`document.startViewTransition`).
This is a pure **progressive enhancement**: browsers without support get the exact
instant swap they have today.

## Why this app is a good fit

Every screen swap in the app funnels through a single line —
`frontend/src/components/app-root.js` `_renderView()`:

```js
this._view.replaceChildren(document.createElement(tag));
```

Wrapping that one mutation in a view transition animates the whole app. Navigation
is already centralized in `frontend/src/router.js` (`navigate()` → `pushState`;
`popstate` → `emit()`), so we also have a clean hook for transition **direction**.

Two clarifications:

- This is the **same-document (SPA)** API, not the cross-document/MPA variant
  (`@view-transition { navigation: auto }`). The app is a client-routed SPA, so
  same-document is correct.
- **Feature-detected fallback:** `if (!document.startViewTransition) swap()`.
  Browsers still catching up (notably Firefox) simply get the instant swap. No risk.

## Scope

| Phase | What | Status |
|-------|------|--------|
| 0 | Baseline crossfade across all screens, feature-detected + reduced-motion gated | In this plan |
| 1 | Directional slides for the linear flow (`/today → /check → /review → /results`), direction derived from flow order | In this plan |
| 2 | Shared-element morphs (`view-transition-name`): header anchor, photo → results | **Deferred** (see constraint below) |

## Design (Phase 0 + 1)

Three small, isolated edits. Direction is derived from **flow order**, not history
mechanics, so the slide always feels right whether the user tapped a link or used
the browser/hardware back button.

### 1. Router — emit a direction (`frontend/src/router.js`)

Track the previous route; compute direction by comparing positions in the flow order:

```js
const ORDER = ["/today", "/check", "/review", "/results"];
let prev = currentRoute();

function emit() {
  const route = currentRoute();
  const dir = ORDER.indexOf(route) < ORDER.indexOf(prev) ? "back" : "forward";
  prev = route;
  listeners.forEach((fn) => fn(route, dir));
}
```

Both `navigate()` and the `popstate` handler already funnel through `emit()`, so
this covers link taps *and* the hardware back button in one path. Unknown routes
(`indexOf` → -1) fall back to `forward`.

### 2. app-root — wrap the swap (`frontend/src/components/app-root.js`)

```js
_renderView(direction = "forward", firstMount = false) {
  // ...existing tag resolution + `app--chromeless` class...
  const swap = () => {
    this._view.replaceChildren(document.createElement(tag));
    this._view.focus();
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (firstMount || reduced || !document.startViewTransition) {
    swap();
    return;
  }
  const root = document.documentElement;
  root.classList.add(`vt-${direction}`);
  const vt = document.startViewTransition(swap);
  vt.finished.finally(() => root.classList.remove("vt-forward", "vt-back"));
}
```

The two `onRouteChange` subscriptions (currently `() => this._renderView()`) pass
the direction through: `onRouteChange((route, dir) => this._renderView(dir))`.

Three deliberate choices:

- **Reduced-motion gated in JS, not CSS** — see the reduced-motion section below for
  why the existing global CSS reset does *not* cover this.
- **`firstMount` skips the transition** on initial mount, so there's no intro flash.
- **Class-on-`<html>` (`vt-forward` / `vt-back`) instead of the newer `types` option.**
  The `types` API + `:active-view-transition-type()` only landed in Chrome ~125; the
  class approach works on everything that supports view transitions at all (Chrome
  111+, Safari 18+). A better support floor for a public app.

### 3. CSS — the animations (`frontend/src/styles/app.css`)

With no `view-transition-name` assigned yet, the whole screen is captured as the
`root` group, so we animate `::view-transition-old(root)` / `-new(root)`:

```css
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 220ms; }
html.vt-forward::view-transition-old(root) { animation: vt-out-left  220ms both; }
html.vt-forward::view-transition-new(root) { animation: vt-in-right  220ms both; }
html.vt-back::view-transition-old(root)    { animation: vt-out-right 220ms both; }
html.vt-back::view-transition-new(root)    { animation: vt-in-left   220ms both; }
/* + 4 short @keyframes: translateX ± a small offset, opacity 0 → 1 */
```

Phase 0 alone is just the default crossfade (the `animation-duration` line); Phase 1
adds the four directional rules + keyframes.

## Reduced-motion handling (required)

The app already has a global reset in `frontend/src/styles/app.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    /* ... */
  }
}
```

**This does not cover view transitions.** The `*` selector does not match the
`::view-transition-*` pseudo-elements — they live in a separate pseudo-element tree
rooted on the document element, not in the normal DOM the universal selector walks.
So a view transition would still animate for a user who has asked for reduced motion.

**Fix (belt): gate the `startViewTransition` call in JS** on
`matchMedia("(prefers-reduced-motion: reduce)").matches` (shown in edit #2). When
reduced motion is requested, we skip the transition entirely and do the plain
instant swap — the transition machinery never starts, so there is nothing to animate.

**Optionally (suspenders): scope the CSS** under
`@media (prefers-reduced-motion: no-preference)`. Redundant given the JS gate, but
harmless and self-documenting. Decide during implementation.

## Known constraint (shapes Phase 2, informs testing of Phase 1)

Views populate **asynchronously on connect** (their `connectedCallback`s read
IndexedDB). `startViewTransition` snapshots the DOM synchronously right after the
swap callback runs — so it may capture the incoming screen's *first, still-loading*
frame.

- For a **crossfade** (Phase 0) this is imperceptible.
- For a **directional slide** (Phase 1) an empty incoming frame is slightly more
  noticeable. IndexedDB reads are fast, so it is usually fine; **verify per screen**
  during implementation. If any screen's pop-in is jarring, the fix is local: render
  a skeleton first frame, or make that view's initial paint synchronous.
- For **shared-element morphs** (Phase 2) the incoming snapshot *must* contain the
  real target element, so Phase 2 likely needs a rendering-order change. This is the
  main reason Phase 2 is deferred rather than done now.

## Footprint & risk

- ~15 lines in `router.js`, ~10 in `app-root.js`, ~20 of CSS.
- No dependency changes.
- Fully feature-detected and reduced-motion-safe; degrades to today's behavior.

## Verification checklist (when implemented)

- [ ] Forward flow (`/today → /check → /review → /results`) slides left/in-from-right.
- [ ] Back (link and hardware/browser back button) slides the opposite way.
- [ ] `prefers-reduced-motion: reduce` → instant swap, no animation on the VT pseudos.
- [ ] Unsupported browser (or `document.startViewTransition` undefined) → instant swap.
- [ ] First mount (and setup → app) does not flash a transition.
- [ ] Focus still lands on `#view` after each swap (accessibility — unchanged behavior).
- [ ] format / lint / typecheck / test / build green across workspaces.
