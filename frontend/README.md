# Frontend

The Good Neighbor App web frontend — vanilla **web components** + **Web Awesome**, built with
**Vite**, hosted on S3/CloudFront. Ported from the `gnp` prototype (Step 2 of the migration).
Type safety is JSDoc + `tsc --checkJs`.

## Run it

```bash
npm run dev -w frontend       # dev server
npm run build -w frontend     # production build → dist/
npm run typecheck -w frontend # tsc --checkJs
npm run dev:lan -w frontend # launches vite with external friendly config
```

First run shows the site-setup screen. To get it back after binding a site you can logout.

## Design system reference (dev-only)

`npm run dev -w frontend`, then open **http://127.0.0.1:5173/design-system.html** — a
self-demonstrating page rendering every button state, the tokens (live values, light +
dark), and where we deliberately diverge from off-the-shelf Web Awesome. It imports the
real `tokens.css`/`base.css` plus the component sheets, so it can't drift. Dev-only: `vite build` ships only the app's
`index.html`.

## Routes

- `/today` — the home hub (worklist, last log, Start/Flag CTAs)
- `/check` — perimeter check capture: one flat photo roll for the whole perimeter. Finish
  unlocks at three photos or one saved description (`src/domain/check-completion.js`).
- `/check/describe` — the description alternative to photos (one per check; reopening
  edits it)
- `/problem` — single-issue capture (with a `/problem/describe` variant)

First-run site setup is enforced by `app-root`, not by a route. There is no per-site
places setup: a bound device lands straight on `/today`
([ADR 0014](../docs/adr/0014-remove-places-photo-roll.md)).

## Layout

```text
src/
  components/   web components — one <thing>.js (+ <thing>.templates.js for markup, <thing>.css for styles)
  styles/       tokens.css (design tokens) · base.css (shared vocabulary: shell, screen, buttons, forms, sheet)
  services/     backend API calls (services/api.js is the seam)
  state/        check-session and other app state
  domain/       read-model adapters (backend items → UI records) · check-completion.js (the perimeter completion rule)
  lib/          html tag helper, escaping
  db.js         IndexedDB (site binding + resumable draft + review-backed session)
  router.js     tiny History-API router
```

Convention: a component's logic lives in `<name>.js`; its pure `(data) → HTML string`
templates live in `<name>.templates.js`; its styles live in `<name>.css`, imported as the
first import of `<name>.js` (see `site-switcher`, `ticket-detail-dialog`, `today-view`).
`styles/base.css` holds only the shared vocabulary every screen uses; a class that one
component renders belongs in that component's sheet. Vite bundles every imported sheet into
one CSS file, so this is about ownership, not delivery; `main.js` imports `base.css` before
any component, so component rules always follow the base in the cascade. Child elements that
must survive a parent's `innerHTML` re-render (dialogs, menus) are created once by the parent
and re-attached after each render (see `today-view._mountSiteSwitcher`).

## Additional docs

- **[Design system — building screens to spec](../docs/frontend-design-system.md)** — the class
  + token vocabulary and a recipe for building a screen that matches the app **without a mockup**.
  Start here before adding any new screen or styles.
- [Docs map](../docs/README.md) — reference docs: architecture, data model, ADRs.
- [GitHub issue tracker](https://github.com/Mayor-s-Office-of-Innovation/good-neighbor-app/issues) —
  open work and what's left on the way to a deployed MVP.

Design tokens and the shared classes are documented inline in
[src/styles/tokens.css](./src/styles/tokens.css) and [src/styles/base.css](./src/styles/base.css);
component classes are documented in each component's `.css`.
