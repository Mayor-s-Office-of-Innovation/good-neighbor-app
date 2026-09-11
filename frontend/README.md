# Frontend

The Good Neighbor App web frontend — vanilla **web components** + **Web Awesome**, built with
**Vite**, hosted on S3/CloudFront. Ported from the `gnp` prototype (Step 2 of the migration).
Type safety is JSDoc + `tsc --checkJs` (lenient baseline; see the migration plan).

## Run it

```bash
npm run dev -w frontend       # dev server
npm run build -w frontend     # production build → dist/
npm run typecheck -w frontend # tsc --checkJs
```

First run shows the site-setup screen. To get it back after binding a site, clear the local
binding — see [Clearing the local site binding](../docs/dev-commands.md#clearing-the-local-site-binding)
in the developer command reference.

## Routes

- `/today` — the home hub (worklist, last log, Start/Flag CTAs)
- `/check` — perimeter check capture
- `/problem` — single-issue capture (with `/problem/describe` and `/check/describe` variants)

First-run site setup is enforced by `app-root`, not by a route.

## Layout

```text
src/
  components/   web components — one <thing>.js (+ optional <thing>.templates.js for markup)
  styles/       tokens.css (design tokens) · app.css (component classes) · wa-*.css (vendored WA)
  services/     backend API calls (services/api.js is the seam)
  state/        check-session and other app state
  domain/       read-model adapters (backend items → UI records)
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
