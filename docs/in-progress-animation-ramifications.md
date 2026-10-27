# In-progress animations: ramifications (2026-10-27)

Branch `ui/progress-animations` reworks the two in-progress animations. For
the development team — what changed beyond the visuals.

## i18n: trailing ellipsis moved from copy to markup

- `card.pending.title` ("Analyzing...") and `analysis.progressDialog.title`
  ("Filing ticket...") lost their trailing ellipsis in **all five catalogs**
  (en, es, fil, vi, zh-Hant; zh-Hant used `…`).
- The dots are now presentation: `animatedEllipsis()` in
  `frontend/src/lib/ellipsis.js` renders three always-present, `aria-hidden`
  dots animated by `.ellipsis-dots` in `base.css` (opacity/transform only, no
  reflow). Screen readers hear the plain status once; the visually-hidden
  capture-label copy intentionally has no dots.
- Translators adding new in-progress strings should leave the ellipsis out of
  the copy and let callers append the helper.
- Other catalog strings still ending in `…` (admin.*, care.*, setup.*,
  common.loading) were left as-is; they are candidates for the same helper.

## Status-ticker spinner: wa-icon → inline SVG

- The "Looking for duplicates" spinner no longer rotates; it is an inline SVG
  of eight circles (Font Awesome spinner positions) whose opacities fade in
  sequence (1.1s cycle, one-eighth stagger via negative inline delays).
- The element keeps the `status-ticker__spinner` class (template tests
  unchanged and passing) and is `aria-hidden`.
- `.status-ticker > wa-icon` sizing no longer matches it; the SVG carries its
  own 15px sizing. That rule still applies to the ticker's other icons.
- The `ticker-spin` keyframe and its rotation animation were **removed** —
  nothing else referenced them.

## Capture screen pending label (user-directed addition)

- The `capture-label--pending` shimmer bar (sparkles + skeleton pill above
  "Describe instead") is replaced by the same animated ellipsis; the unused
  `.capture-label__skeleton` rule was removed. Other skeletons (analysis-card,
  home shimmer) are untouched.

## Reduced motion

- The global `base.css` reduced-motion rule freezes animations at ~0ms, which
  could park the dots at their dimmest keyframe. Both features add explicit
  `prefers-reduced-motion` rules: animations off, dots statically visible at
  reduced opacity (ticker circles 0.6, ellipsis dots 0.75).

## No new dependencies, no will-change

Both animations are plain CSS on existing elements; no compositor-layer
forcing anywhere.
