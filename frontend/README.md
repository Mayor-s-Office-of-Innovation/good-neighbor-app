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
real `tokens.css`/`app.css`, so it can't drift. Dev-only: `vite build` ships only the app's
`index.html`.

## Routes

- `/today` — the home hub (worklist, last log, Start/Flag CTAs)
- `/check` — perimeter check capture: one flat photo roll for the whole perimeter. Finish
  unlocks at five photos or one saved description (`src/domain/check-completion.js`).
- `/check/describe` — the description alternative to photos (one per check; reopening
  edits it)
- `/problem` — single-issue capture (with a `/problem/describe` variant)

First-run site setup is enforced by `app-root`, not by a route. There is no per-site
places setup: a bound device lands straight on `/today`
([ADR 0014](../docs/adr/0014-remove-places-photo-roll.md)).

## Layout

```text
src/
  components/   web components — one <thing>.js (+ optional <thing>.templates.js for markup)
  styles/       tokens.css (design tokens) · app.css (component classes)
  services/     backend API calls (services/api.js is the seam)
  state/        check-session and other app state
  domain/       read-model adapters (backend items → UI records) · check-completion.js (the perimeter completion rule)
  lib/          html tag helper, escaping
  db.js         IndexedDB (site binding + resumable draft + review-backed session)
  router.js     tiny History-API router
```

Convention: a component's logic lives in `<name>.js`; if its markup grows, split the pure
`(data) → HTML string` templates into `<name>.templates.js` (see `site-setup`, `today-view`).

## Additional docs

- **[Design system — building screens to spec](../docs/frontend-design-system.md)** — the class
  + token vocabulary and a recipe for building a screen that matches the app **without a mockup**.
  Start here before adding any new screen or styles.
- [Docs map](../docs/README.md) — reference docs: architecture, data model, ADRs.
- [GitHub issue tracker](https://github.com/Mayor-s-Office-of-Innovation/good-neighbor-app/issues) —
  open work and what's left on the way to a deployed MVP.

Design tokens and component classes themselves are documented inline in
[src/styles/tokens.css](./src/styles/tokens.css) and [src/styles/app.css](./src/styles/app.css).
