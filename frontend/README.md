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
binding — see [Clearing the local site binding](../README.md#clearing-the-local-site-binding)
in the root README.

## Layout

```text
src/
  components/   web components — one <thing>.js (+ optional <thing>.templates.js for markup)
  styles/       tokens.css (design tokens) · app.css (component classes) · wa-*.css (vendored WA)
  services/     backend/analyzer/onboarding calls
  state/        check-session and other app state
  lib/          html tag helper, escaping
  db.js         IndexedDB (site binding + saved checks)
  router.js     tiny History-API router
```

Convention: a component's logic lives in `<name>.js`; if its markup grows, split the pure
`(data) → HTML string` templates into `<name>.templates.js` (see `site-setup`, `today-view`).

## Additional docs

- **[Design system — building screens to spec](../docs/frontend-design-system.md)** — the class
  + token vocabulary and a recipe for building a screen that matches the app **without a mockup**.
  Start here before adding any new screen or styles.
- [Frontend migration plan (Step 2)](../docs/gnp-frontend-migration-plan.md) — how `gnp` became
  `frontend/`, plus the open backend/auth/deploy decisions and the deferred offline pass.
- [Docs map](../docs/README.md) — every planning thread with its ordered read path.
- [MVP tracker](../docs/MVP-TODO.md) — what's left on the way to a deployed MVP.

Design tokens and component classes themselves are documented inline in
[src/styles/tokens.css](./src/styles/tokens.css) and [src/styles/app.css](./src/styles/app.css).
