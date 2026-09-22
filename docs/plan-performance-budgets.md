# Plan: CI performance gates — bundle budgets + Lighthouse

> **Temporary working document.** Delete this file once both phases ship. Per
> [docs/README.md](./README.md), durable facts move into the reference docs (the commands
> go to [dev-commands.md](./dev-commands.md), the budget decision gets an ADR) and the rest
> is dropped. Written 2026-09-22 against `dev`.

## Goal

Accessibility tests are now gated in CI; performance gets the same treatment. Two
complementary gates, both running on every PR:

1. **Bundle-size budgets** (Size Limit) — deterministic, sub-second. Catches the most
   common regression: a PR that quietly adds dependency weight. Answers "did this PR make
   the app *fatter*?"
2. **Lighthouse CI lab metrics** (LCP / TBT / CLS) against the production build. Catches
   what size can't: render-blocking CSS, layout shift, long tasks. Answers "did this PR
   make the app *slower*?"

Both run as a new `perf` job in [ci.yml](../.github/workflows/ci.yml) so the existing
`app` and `e2e` jobs stay untouched and can fail independently. The job deliberately
**keeps running on `dependabot[bot]` PRs** — dependency bumps are exactly the change this
gate exists to catch (the `security` job skips Dependabot; this one must not).

## Bundle-size investigation — where we are today

Measured 2026-09-22, fresh `npm run build -w frontend` (Vite 8.2.1, 127 modules, single
entry, no code splitting). Sources: Vite's build report, `rollup-plugin-visualizer`
(`npx vite-bundle-visualizer`), and gzip of the dist assets.

### Wire payload (what CloudFront would serve)

| Asset | Raw | Gzip |
|---|---|---|
| `dist/assets/index-*.js` | 338.8 kB | 84.1 kB |
| `dist/assets/index-*.css` | 193.9 kB | 28.4 kB |
| `dist/index.html` | 3.4 kB | 1.3 kB |
| **Total (JS + CSS + HTML)** | **536 kB** | **~114 kB** |

Sourcemaps (`860.9 kB`) are uploaded to PostHog by the deploy workflow and excluded from
the public S3 sync — they don't count against the user payload. No image/font assets ship
in the bundle (icons are individual SVGs fetched on demand; fonts are system-stack).

### Composition of the JS chunk (by module, approximate)

| Share | Contents |
|---|---|
| ~53% | App source (`frontend/src/**`) — 16 components + services + state |
| ~40% | Web Awesome (`@awesome.me/webawesome` chunks, tree-shaken) |
| ~7% | Web Awesome's Lit runtime (lit-html, @lit/reactive-element, @shoelace-style/localize) |

Largest single modules: `today-view.js` ~56 kB rendered, one Web Awesome chunk ~39 kB,
`perimeter-check.js` ~21 kB, `photo-analysis.js` ~19 kB, `problem-report.js` ~18 kB,
`analysis-results.templates.js` ~17 kB.

### Findings

- **One chunk for everything.** `main.js` registers every component eagerly and Vite
  emits a single JS chunk — the whole app loads on every route. There is no route-level
  code splitting today.
- **Web Awesome is already cherry-picked** (per-component imports in `main.js`, ~8
  components + tree-shaken theme). The 40% share is the floor of "form controls + Lit
  runtime", not an accident — but it means the budget ratchet should watch WA upgrades
  closely.
- **CSS is heavy relative to the app: 194 kB raw** (37% of payload, but compresses to
  28 kB). Drivers: `app.css` is ~99 kB of source, plus Web Awesome's `native.css` /
  `layers.css` / `utilities.css` and the vendored `wa-awesome.css` theme (~25 kB).
- **`index.html` carries an inline theme-init script** (~1.5 kB, deliberately render-
  blocking to prevent theme flash — see `index.html`). Lighthouse will flag
  render-blocking resources; this one is a known, accepted trade-off, not something to
  chase.
- The offline/PWA pass (vite-plugin-pwa) is intentionally OFF for MVP; when it ships, the
  precache manifest will make every budget number double-counted — revisit budgets then.

### Baseline numbers for the budgets

Measured 2026-09-22 with `npx size-limit --limit "10 MB" <files>` against the fresh
build — Size Limit's metric is **brotli**, which lands ~17% under gzip:

| Check | Baseline (brotli) | Start limit (+10%) |
|---|---|---|
| JS bundle (`dist/assets/*.js`) | 69.6 kB | 75 kB |
| CSS (`dist/assets/*.css`) | 21.6 kB | 24 kB |
| **Total** | **91.2 kB** | — |

Set budgets from these, then ratchet: **limit = baseline + 10%**, never "re-baseline to
pass". Raising a limit is a deliberate, reviewable `frontend/package.json` edit — that
review is the bypass, by design.

## Phase 1 — Size Limit (bundle budgets) — SHIPPED as hard gate

> **Status (2026-09-22):** wired into CI as a gating `perf` job with limits at the
> measured baseline +10% (75 kB JS / 24 kB CSS brotli). The sections below are the plan
> as designed; see `frontend/package.json` (`size-limit` + `size` script) and the
> `perf` job in `.github/workflows/ci.yml` for what actually ships.

**Tool:** [Size Limit](https://github.com/ai/size-limit) (`size-limit` +
`@size-limit/file`) — 6.9k stars, MIT, zero runtime deps added to the app. Chosen over
hand-rolling a `du | gzip` script: brotli measurement, per-section budgets, `--why`
bundle analysis (via Statoscope) out of the box. Per the web-dev standard: it earns its
place because measuring real brotli cost + PR-comment output isn't a platform capability.

**Why `@size-limit/file` (not the webpack/esbuild presets):** Vite already built the
bundle; we only need to measure the emitted files. No second bundler in CI.

**Setup (human runs the installs):**

```bash
npm i -D -w frontend size-limit @size-limit/file
```

**Config** — `size-limit` section in `frontend/package.json` (limits = measured baseline
+10%, from the table above):

```json
"size-limit": [
  { "name": "js",  "path": "dist/assets/*.js",  "limit": "75 kB" },
  { "name": "css", "path": "dist/assets/*.css", "limit": "24 kB" }
],
"scripts": { "size": "size-limit" }
```

(The sourcemap `*.js.map` files don't match `*.js` glob → excluded automatically.
Total-transfer budget is implied by the two sections; add a third section if we ever
want one number.)

**First-run ritual:** `npx size-limit` with no limits → capture the real brotli baseline →
write the limits above from it → commit. A PR that busts a budget shows the exact KB over
and `npx size-limit --why` names the dependency that did it.

**CI wiring** — new job in `.github/workflows/ci.yml`:

```yaml
perf:
  name: Performance budgets
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
    - uses: actions/setup-node@v7
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npm run build -w frontend
    - run: npx size-limit
      working-directory: frontend
```

**Acceptance:** a PR adding >10% JS weight fails `perf` with a message naming the overage;
existing PRs pass. Runtime cost: ~10 s on top of the existing build.

## Phase 2 — Lighthouse CI (lab metrics on the prod build) — SHIPPED, warn-only

> **Status (2026-09-22):** wired into the same `perf` CI job after size-limit, warn-only
> per the user decision — **not deploy-blocking**. Promotion to hard gate is a separate
> change after the noise-floor observation window (see below). Config as designed lives
> in `frontend/lighthouserc.json`; the hermetic option (no `upload` block) was chosen —
> `lhci autorun` collects + asserts locally, results print in the job log, and the full
> HTML/JSON reports upload as a `lighthouse-reports` run artifact (7-day retention,
> `if: always()` — warn-level regressions don't fail the job, so the artifact is the
> only way to see their reports).

**Tool:** [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci) (`@lhci/cli`) —
Google-maintained, 7.1k stars. It serves `dist/` itself (`staticDistDir`), so no
`vite preview` server management. Lighthouse's default **simulated throttling (Lantern)**
is used rather than real network shaping — less variance on shared CI runners.

**Why not a Playwright perf test:** the e2e suite measures the *dev server* through the
full local harness (backend + analyzer stub + MinIO) — harness noise would make timing
asserts flaky, and it isn't the production artifact. LHCI measures the built `dist/` in
isolation.

**Setup:**

```bash
npm i -D -w frontend @lhci/cli
```

**Config** — `frontend/lighthouserc.json` (as shipped):

```json
{
  "ci": {
    "collect": {
      "staticDistDir": "dist",
      "numberOfRuns": 3,
      "settings": { "skipAudits": ["uses-http2"] }
    },
    "assert": {
      "aggregationMethod": "median",
      "assertions": {
        "categories:performance": ["warn", { "minScore": 0.8 }],
        "largest-contentful-paint": ["warn", { "maxNumericValue": 4000 }],
        "total-blocking-time": ["warn", { "maxNumericValue": 500 }],
        "cumulative-layout-shift": ["warn", { "maxNumericValue": 0.1 }],
        "resource-summary:script:size": ["warn", { "maxNumericValue": 400000 }],
        "resource-summary:stylesheet:size": ["warn", { "maxNumericValue": 250000 }]
      }
    }
  }
}
```

Notes:
- **`median` of 3 runs** tames CI-runner variance. Assertions start at `["warn", …]` —
  visible but non-blocking — and are promoted to `["error", …]` after ~2 weeks of runs
  confirms the noise floor (Phase-2 exit criterion).
- `skipAudits: uses-http2` because localhost serving can't exercise the CDN's HTTP/2.
- The resource-summary asserts are a second net behind Size Limit (catches HTML/inline
  growth too); the category + metric asserts are the real gate.
- Hermetic by choice: no `upload` block, so nothing leaves CI. `autorun` runs
  collect + assert against the static build only.
- Known accepted findings, not to be chased: the inline theme-init script
  (render-blocking by design), missing HTTP/2 on localhost, "no service worker" until the
  offline pass.

**CI wiring** — appended to the `perf` job after the size-limit step:

```yaml
    - run: npx lhci autorun
      working-directory: frontend
```

No extra browser install needed: ubuntu-latest ships Chrome and LHCI finds it; add
`CHROME_PATH` only if that ever breaks.

**Acceptance:** `perf` job reports Lighthouse scores on every PR; the three CWV-style
metrics appear in the job log; after the observation window the assertions flip to
`error` and a synthetic regression (e.g. a deliberately layout-shifting change) fails the
job.

## Rollout order & ratchet rules

1. ~~Land Phase 1~~ **Done (2026-09-22):** hard gate live in the `perf` job.
2. ~~Land Phase 2 warn-only~~ **Done (2026-09-22):** lhci runs warn-only, not
   deploy-blocking; let it run ~2 weeks across normal PRs.
3. Read the variance off the run history, tighten the LHCI numbers to ~10% above
   observed median, flip `warn` → `error`. **Remaining — promotion PR.**
4. Budget changes afterwards are PRs that show the delta and justify it ("WA upgrade
   moves JS 92 → 97 kB, accepted because X") — never a silent bump to green.
5. Post-prod-deploy (future, out of scope here): a scheduled nightly LHCI run against the
   real dev environment so CloudFront/TLS/headers are in the measurement.

## Out of scope

- Backend/Lambda performance (cold starts, analyze-worker latency) — server-side, no
  browser harness; separate effort if it ever matters.
- Real-user monitoring / SaaS synthetic tools (Calibre, DebugBear) — no traffic to
  measure yet; revisit after prod launch.
- The bundle optimizations this investigation surfaced (route-level code splitting,
  `app.css` diet) — budgets will force the conversation; do them as their own PRs when a
  budget busts, not preemptively in this one.