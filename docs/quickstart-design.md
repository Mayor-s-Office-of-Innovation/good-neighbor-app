# Quickstart for design contributors

**Who this is for:** you are changing CSS, templates, or copy to match the Figma designs and
want the app running on your laptop in a few minutes. You do not need the backend, Java, or
any AWS access. The page you run locally talks to the **deployed dev environment** for data.

Engineers working on handlers, workers, or data should use the full local harness instead:
[dev-commands.md](./dev-commands.md).

## 1. Install

- **Node 24.** `.nvmrc` pins it: `nvm use` (or install from [nodejs.org](https://nodejs.org)).
- Clone the repo and, from its root:

```bash
npm install
```

That is the whole install. No Java, no Docker, no `.env` file, no API keys.

## 2. Run

```bash
npm run dev:remote
```

Open **http://127.0.0.1:5173**. Enter the site code **`MOICHL`** (MOI / City Hall) on the
first screen. You are now in the field app as a City Hall staff device, seeing City Hall's
real dev data: checks, tasks, history, reports.

What `dev:remote` does: the Vite dev server serves your working copy of the frontend and
forwards every API call to `https://dev.goodneighborsf.org`. Photo uploads are forwarded the
same way. No deployed code or configuration is touched, but your laptop becomes another
client of dev: anything you submit (checks, photos, task updates) is real shared dev data,
visible to everyone bound to that site (see "Things to know about dev" below). Details in
[`frontend/vite.config.js`](../frontend/vite.config.js) and
[`frontend/scripts/vite-remote-api.mjs`](../frontend/scripts/vite-remote-api.mjs).

Edits to anything under `frontend/src/` hot-reload in the browser.

### Phone or tablet on the same Wi-Fi

```bash
API_PROXY_TARGET=https://dev.goodneighborsf.org npm run dev:lan -w frontend
```

The terminal prints a `Network:` URL to open on the device. Camera and location need HTTPS on
most phones, so this is for layout checks; for camera flows use the deployed dev site
itself.

### Accessibility check with screenshots

After a CSS or color change, run the same accessibility checks CI runs, against your
local build, and get a screenshot of every screen with each finding boxed and numbered:

```bash
npx playwright install chromium        # once
npm run a11y:local -w e2e              # with npm run dev:remote still running
```

The first run binds City Hall once and saves that session under `e2e/.a11y-local/`, so
later runs do not spend site-code uses (seeded codes allow three redemptions in total).
Every run renews that session and saves it back, because sessions expire after 15
minutes and renewal is single-use, so the saved file is tied to this machine: do not
copy it elsewhere, and if the tool says the session did not restore, rerun with
`A11Y_LOCAL_REBIND=1` (one redemption) or ask an engineer for a fresh code.
It then visits nine screens in light and dark, mobile and desktop, and writes:

- `e2e/ramp-check-report/screenshots/` — one PNG per screen and theme. Red boxes are
  WCAG 2.2 A/AA failures; blue boxes are AAA warnings, mostly the 7:1 enhanced-contrast
  rule. The number in each badge matches the `#` column in the report.
- `e2e/ramp-check-report/ramp-check.md` — the findings table: which rule, which element,
  what to do, with the box number.

The screens are the ones the e2e suite scans, minus code entry and the photo lightbox
(uploading a photo would create a real check in dev). Reports screens use fixed sample
data so the day and 311 views always have content. Set `A11Y_LOCAL_SITE_CODE` to use a
different site; delete `e2e/.a11y-local/state.json` if the saved session stops working.

### Things to know about dev

- Checks and photos you submit go through the real dev analyzer and show up for anyone
  bound to City Hall in dev. Use City Hall for design work so other sites' testers are not
  confused by stray checks.
- You cannot reset dev data from your laptop. If you need empty states, ask an engineer for
  a fresh sandbox site code.
- The deployed dev frontend at <https://dev.goodneighborsf.org> is the same code against the
  same data, so side-by-side comparison with your local build is free.
- The dev-only guidance harness page and the admin console do not work in this mode (they
  need the local backend or a Cognito login respectively).

## 3. Design references in the repo

| What | Where |
|---|---|
| Every button state, live token swatches (light + dark), where we diverge from Web Awesome | **http://127.0.0.1:5173/design-system.html** while `dev:remote` runs |
| Dark/light toggle in the app | add `?themeToggle` to any URL, e.g. `http://127.0.0.1:5173/today?themeToggle`. A manual choice sticks in `localStorage` (`theme-override`); remove it to follow the OS again |
| Design tokens (the Figma ↔ code mapping; **the repo is the source of truth**, not Figma) | [design-tokens.md](./design-tokens.md) and [`frontend/src/styles/tokens.css`](../frontend/src/styles/tokens.css) |
| Class and token vocabulary, how to build a screen to spec | [frontend-design-system.md](./frontend-design-system.md) |
| Frontend layout and conventions | [frontend/README.md](../frontend/README.md) |

Which app is which: the **field app** (`frontend/`) is what staff use on phones and tablets
and is what `dev:remote` runs. The **admin console** (`admin-frontend/`) is the central
admin's desktop tool and is a separate build.

## 4. Four rules that will bite you

1. **No hard-coded colors.** Every color, radius, and shadow is a token in `tokens.css`.
   Add a token if one is missing; never write a hex in a component sheet.
2. **Buttons are native `<button>` with a `.btn-*` class**, never `<wa-button>`
   ([ADR 0011](./adr/0011-native-buttons.md)). Form controls, icons, badges, and callouts
   stay Web Awesome.
3. **No English text in templates.** Every visible string goes through `t("key")` with the
   English in [`frontend/src/i18n/catalogs/en.json`](../frontend/src/i18n/catalogs/en.json).
   Change the copy there; the other four locales are filled in separately
   ([localization.md](./localization.md)).
4. **A component's CSS lives next to it** in `<name>.css`, imported first in `<name>.js`.
   `base.css` holds only the shared vocabulary every screen uses.

## 5. Before you push

```bash
npm run format        # Prettier — CI fails on formatting, this fixes it
npm run lint
npm test
```

Branch from `dev`, open a PR back to `dev`, and a code owner will review. The infra tooling
in [CONTRIBUTING.md](../CONTRIBUTING.md) (`pre-commit`, Terraform, signed commits) is for
infrastructure changes; frontend-only PRs do not need it.
