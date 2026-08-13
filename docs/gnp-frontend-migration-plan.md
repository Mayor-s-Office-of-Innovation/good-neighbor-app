# Plan: migrate the `gnp` prototype in as the frontend

Status: **partially DONE** — the frontend port (Step 2) landed 2026-08-12; the
backend/auth/deploy seams remain open.
Date: 2026-08-11

> **Completion note (2026-08-12).** The **UI port itself is done and green**
> (format/lint/typecheck/test/build across workspaces); `gnp` now lives in
> `frontend/`. What landed: **M1** (WA `^3.11`), **M3** (self-hosted fonts + vendored
> theme + local icon library), **M4** (workspace/tooling align, spike + transcription
> docs carried), **M5** (JS+JSDoc lenient landing — `strict:false` + `@ts-nocheck`
> baseline on 11 files), and the **routing half of I2** (History-API routing +
> `base:'/'` + a delegated link interceptor; the CloudFront `index.html` fallback is
> still I1).
>
> **Deliberately deferred to a post-MVP "offline pass"** (product decision — avoid
> stale-cache/complexity while screens iterate): **M2** (PWA/`vite-plugin-pwa` is
> carried into devDeps but **un-wired — no service worker ships**) and its
> background-sync write-queue, plus **I3** (CSP hash for the inline theme script — the
> script ships un-hashed for now). Those two land together when offline is turned on.
>
> **Still open / not started:** all design decisions that gate backend work — **D1**
> (auth / server-mediated analysis), **D2** (backend contract + `sync.js`), **D3**
> (data-classification security review), **D4** (DynamoDB-vs-Postgres, parked) — and
> **I1** (frontend build→S3/CloudFront deploy stage). The services
> (`analyzer`/`transcribe`/`onboarding`) remain **mocked**. See memory
> `step2-gnp-port-scope` for the exact landed state.

Tracks everything that must be resolved to bring the `gnp` Phase-1 prototype
(`../gnp`) in as the frontend of this repo. `gnp` is a well-built vanilla-web-
components PWA (run a perimeter check → mocked analyzer returns a 12-category
scorecard → local findings, offline-first, IndexedDB, no backend, no auth). The UI and offline mechanics port cleanly — even
improve on the scaffold. The work is almost all at the **seams** with this repo's
architecture and CCSF Level 2 standards.

**Source prototype:** `gnp` is a separate prototype at `/Users/aaron.hans/dev/gnp`
(local only, un-versioned, **not part of this repository**). It is being migrated into
this repo ASAP — step 2 (M-series) folds its files into `frontend/` — so its
un-versioned state is fine; it stops being a separate thing once that lands. Until
then it lives only at that path. The `gnp` file facts in this plan were verified
against that frozen copy on 2026-08-11.

## Before you start (session setup)

- **Add `../gnp` as a readable working directory** in this session — otherwise the
  `../gnp/...` references throughout this plan won't resolve.
- Read order: `../gnp/CLAUDE.md` (as-built orientation) → `../gnp/docs/take5-plan.md`
  (design + "stopping line") → `../gnp/docs/migration-port-manifest.md` (file-level
  source→`frontend/` map) → this plan (decisions & order).
- Note: `gnp`'s auto-memory does **not** load in this repo's session (memory is
  per-project); the handoff lives entirely in those committed docs.

Each item has a **Status**: `decision-needed` (product/security call, not mechanical),
`open` (planned work, no blocking decision), or `resolved` (covered elsewhere).

---

## Design decisions — settle these first

These are not mechanical edits; they change what we build.

### D1. Auth model — v1 is no user auth; server-mediated analysis

**Status:** resolved

v1 is a **demo with no user auth**. It **keeps `gnp`'s simple onboarding as-is**
(product call): a code-driven site binding (`?code=…` → confirm the resolved site →
bind; manual code entry as a fallback). The code is the only identity check — **no
login, no location picker**. In `gnp` the code validation is still **mocked** (any
non-empty code resolves to a default site); wiring it to a real endpoint is a later
swap and does not change the UX. The future flow (registration emails → site managers
provision shared iPads → security team uses them without logging in) is explicitly
**out of scope for v1**; even then it is shared-device and site-scoped, not per-user
login. So **shelve the scaffold's Cognito User Pools JWT authorizer**
(`authorizer.jwt.claims.sub`) — that is per-user login and is not v1.

The real v1 auth need is **authenticating calls to the external analysis API**. A public
client (PWA on a shared iPad) cannot hold a real secret, so we use a **server-mediated
flow** — and (revised 2026-08-13) we post the image **base64-inline through our Lambda**,
with **no S3 staging bucket**:

1. Client **downscales** each capture (≤~1568px / ~1–2 MB JPEG) and calls our **Lambda**
   (in this repo) with the image **base64-inline** in the request body — **one call per
   artifact** (per-artifact; see D2).
2. The Lambda calls the **analysis API** — a **standalone shared service of ours on AWS**
   (own repo) — authenticating as a consumer with an **API key** (`x-api-key`, held
   server-side in Secrets Manager); the analyzer trusts only holders of a valid consumer key,
   and the key never leaves our Lambda — the client never sees it. It sends
   **`storage.store_input:false` + `return_signed_urls:false`** so the analyzer keeps no copy.
   (See the revised fork below.)
3. Lambda returns the analysis JSON to the client. **Nothing is persisted at rest** — the
   image lives only transiently in-memory for the request.

**Why no S3 (revised 2026-08-13).** Bedrock caps images at 5 MB and downscales anything over
~1568px, so a staging bucket + presigned upload + an `image_s3` service input buys little, and
the analyzer's base64 input path already exists. The binding size limit is **AWS Lambda's ~6 MB
sync payload** (tighter than Bedrock's 5 MB after ~33% base64 inflation, and it applies on both
the client→Lambda and Lambda→analyzer hops), so **the client must downscale before posting** —
which is optimal anyway. Dropping S3 also **removes person-images at rest entirely**: with no
bucket and `store_input:false`, images are never durably stored, delivering the "no
person-images at rest → Level 2" property directly rather than via a deferred retention pass.

Client→Lambda hop is gated with API Gateway + WAF + throttling (optionally a Cognito
**Identity Pool** guest identity for IAM-authorized calls — still no login). This is
deterrence-grade, acceptable for a demo; real per-device identity arrives with v2 iPad
provisioning. No staging bucket exists to harden; the residual media controls are **no
request-body logging** (API GW + Lambda), analyzer-account **Bedrock invocation logging off**,
and posted-image **validation** (magic-byte + size + count caps).

> **Auth posture reconciled (2026-08-12).** The "deterrence-grade guest Identity Pool"
> above is the **demo** posture only — it does **not** prevent a public caller from
> polluting a site's dataset. The **real-data** posture is **Option 3: the device is
> authenticated as the site** (STS creds carrying `custom:siteId`, `siteId` server-derived
> and `dynamodb:LeadingKeys`-enforced; the client never asserts its own site on a write),
> matching the [data model](dynamodb-data-model.md)'s identity model. Full threat, invariant,
> rejected alternatives, and cross-cutting hardening are recorded in
> [security-review.md](security-review.md); tracked in [MVP-TODO](MVP-TODO.md).

**Fork — resolved 2026-08-12; revised 2026-08-13:** ~~IAM (SigV4), no Secrets Manager
credential~~ → **API key per consumer, held in Secrets Manager.** The premise changed: "ours"
means we own the code + deploy, but the analyzer is a **standalone shared service** — the
scorecard service previously part of **streetconditions.org**, which will consume it as an
external service once stood up, alongside possibly other (non-AWS) consumers. For a shared
service with heterogeneous consumers, **API-key-per-consumer** is the right auth boundary
(per-consumer identity, revocation, throttling; no cross-account IAM coupling). GNP's key is a
**backend-to-backend credential**: our Lambda holds it server-side (Secrets Manager, fetched via
the Lambda role), TLS-only; the **field device never holds it**, so server-mediation is
unchanged. The service lives in a **separate repo (checked out at `../street-conditions-analysis`)
and is not yet deployed as a standalone service.** Standing it up — and issuing GNP a consumer
key — is an **external dependency of the analyze path** (tracked in [MVP-TODO](MVP-TODO.md)).
(Optional future: its API GW could add IAM auth alongside keys for AWS consumers; not built now.)

### D2. Backend contract — perimeter-checks system of record

**Status:** resolved (one sub-question open)

Domain: the app collects **perimeter checks** (perimeter reports). Each check is run at
a site at a point in time and bundles **several photos, optional audio, and optional
text**. Those inputs are analyzed and transformed into a **set of issues discovered**.

Analysis is performed by a **separate backend service** (not this app's backend): media
in, a structured **analysis report as JSON** (issues + types) back. This app is the
**system of record** — it tracks every analysis result received, when each perimeter
check was run, and the history per site.

What our backend persists (no raw media — see D3), via a **caller-side adapter** that maps the
service contract to our shape (revised 2026-08-13; the rubric + data format are **owned by the
analysis service** — ground truth is `street-conditions-analysis/contract/openapi.yaml`):

- Perimeter check: `{ id, siteId, runAt, inputsSummary (photo count, hasAudio, hasText), status }`
- Analysis result (**per artifact** — see note below): our projection of the service scorecard —
  `{ checkId, artifactId, rubricVersion, ratings_details: [{ category, rating, hazard, explanation,
  evidence_indices }] }` (always 12 categories). **Adapter mapping:** service `categories`→
  `ratings_details`, `label`→`category`, `severity`→`rating`, `description`→`explanation`,
  `hazard_detected`→`hazard`. The severity scale is **rubric-owned (0–5 today), not a fixed 0–3** —
  carry it through, don't hard-code the band count. The service returns an optional `confidence`
  we **drop**. It does **not** return `total_score`/`status_label` — **we compute** those in our
  scoring module (matches the "raw components, compute at read" data-model decision). Stamp
  `rubricVersion` so aggregates never mix scales across a version bump.
- Query/history: list checks for a site, time-ordered; per-site and citywide read
  models for the reporting API.

**Per-artifact analysis (resolved 2026-08-13).** One analyzer call per photo/text artifact → one
per-artifact `ANALYSIS` item ([data model](dynamodb-data-model.md)). The UI still consumes a single
**check-level** scorecard: the adapter synthesizes it by taking, per category, the **max `rating`
and OR of `hazard`** across the check's artifacts and unioning the evidence, attributing each
finding to its source artifact directly (not the model's per-call `evidence_indices`).
Batch-per-modality (one call for all a check's photos) is the documented fallback if the analyzer
usage-plan quota/cost bites — at the cost of per-photo attribution.

This persisted shape is deliberately a **lean projection** of `gnp`'s local check
(which carries per-side `items[]`, the cadence `window`, and timestamps): the backend
keeps summary counts + the scorecard, not the full walk structure.

Endpoints replace the generic `POST /api/submissions`: create/complete a perimeter
check, list checks for a site, fetch one, plus the citywide reporting read API. The
`gnp` client maps the scorecard → findings locally; a sync layer is future work —
there is no `sync.js` in `gnp` today (records are flagged `synced:false` for it).

**Who calls the analysis service? — resolved (server-mediated, base64, no S3).** The client
downscales each capture and posts it **base64-inline** to our Lambda (one call per artifact); the
Lambda calls our analyzer service (a standalone shared service of ours on AWS) with GNP's
**consumer API key** (`x-api-key`, held in Secrets Manager) and returns the JSON. This is what
makes caller-auth possible (only our Lambda holds the key) — see **D1** for the full flow and the
no-media-at-rest rationale (revised 2026-08-13: dropped the S3 staging bucket — Bedrock's 5 MB cap
made it low-value, and the binding limit is Lambda's ~6 MB payload). It is the server-mediated
branch, chosen over client-direct because a public client can't be trusted to hold the analyzer key.

Note: the data-layer shape (Prisma models vs DynamoDB items) is pending **D4**.

### D3. Data classification — photos of people and hazards

**Status:** resolved — no cloud photo storage in v1

Decision: **do not persist photos in the cloud for v1.** A photo is submitted for
analysis, then discarded; we persist only the **analysis document** (whether issues
were found and their types). This is deliberate data minimization to avoid holding PII
images at rest.

**Deliberate relaxation (see D1):** the chosen server-mediated flow means photos _do_
transit a **transient S3 staging bucket** — they are not "never in the cloud," but
"briefly staged, then removed." This is an accepted trade to enable caller-auth to the
external analyzer. The minimization now depends on **removal actually happening**: the
Lambda deletes the object as soon as it has the analyzer response, and an S3 lifecycle
rule (~1 hour, incl. noncurrent versions + delete markers) is the backstop. Get that
right or the "no photo storage" property is fiction.

> **MVP testing-phase note (2026-08-12):** implementation of the deletion + lifecycle is
> **deferred to a post-MVP retention pass** (see [MVP-TODO](MVP-TODO.md)). During initial
> testing, staged photos may persist — accepted because test data is disposable and cleared
> between cycles. So the "no photo storage" property is **not yet delivered during testing**;
> the baseline staging-bucket controls (block-public-access, SSE-KMS, TLS-only,
> Lambda-role-only) must still hold, and this must be revisited (and recorded in
> [security-review.md](security-review.md)) before any real (non-test) user data.

Consequences and things that must hold for the decision to actually deliver on its
intent:

- **The image must be truly transient in the backend.** No S3 write. Also no
  _incidental_ persistence: do not put the image bytes on SQS with long retention,
  do not log the image (CloudWatch), and disable/scope Bedrock model-invocation
  logging so request images aren't captured. This directly shapes D2 — the analyze
  path should stream the image to Bedrock in-memory and return issues, separate from
  any durable queue.
- **What we store is the analysis doc** (`{ total_score, status_label,
ratings_details:[{category, rating, hazard, …}], siteId, timestamp }`) — still
  `sensitive` (conditions tied to a site), but not image PII.
- **On-device: no photo/audio bytes are persisted.** `gnp` holds captured photo/audio
  Blobs **in memory only** for the duration of a walk (component state + the
  `check-session` singleton) and discards them after submit. Only capture **metadata**
  (`kind`, `size`, note text, transcript) and the scorecard are written to IndexedDB
  (the `checks` store) — no image/audio bytes at rest on-device, so there is no local
  media-retention policy to set.
- **Level 3 check:** not storing person-images at rest is the key mitigation to stay
  at Level 2, but we still _process_ them transiently. Confirm with security that
  transient analysis (no retention, no logging) keeps us out of the Level 3 trigger,
  and record the classification + the no-storage design in
  [docs/security-review.md](security-review.md).

### D4. Database — DynamoDB vs managed Postgres (PARKED)

**Status:** parked — revisit soon

We want to explore using **DynamoDB instead of managed Postgres/Prisma** for the cloud
database. Pinned for now; revisit before D2's data layer is built.

Context for when we revisit:

- This reverses a standing choice: [AGENTS.md](../AGENTS.md) and
  [ADR 0001](adr/0001-architecture-stack.md) specify managed Postgres + Prisma.
  (Notably the `web-dev` skill default was already DynamoDB; the project overrode it to
  Postgres — so this would revert to the skill default.) Switching means updating
  AGENTS.md, superseding the ADR, and removing Prisma.
- Initial read: access patterns look DynamoDB-friendly — everything is site-scoped and
  time-ordered (partition key `siteId`, sort key `runAt`), with the citywide reporting
  read model designed as a GSI or a separate aggregation. No obvious relational joins.

---

## Deploy & infrastructure gaps

### I1. No frontend build+publish stage

**Status:** open — direction set (build into scaffold; no GitHub Pages)

Decision: **GitHub Pages is dropped entirely.** The deploy system is built into this
repo, targeting S3/CloudFront. This is a TODO to implement, but the direction is
locked.

[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) currently only runs
`terraform apply`. Work to do:

- Add a build → S3 sync → CloudFront invalidation job (OIDC role, no long-lived keys).
- Provision the frontend bucket + CloudFront distribution in Terraform (with the
  required CCSF tags, TLS, HSTS/CSP headers, WAF) if not already present in `infra/`.
- Delete `gnp`'s `.github/workflows/deploy.yml` (Pages) on migration; do not carry it
  over.
- Because we are not on Pages, the Pages-isms in **I2** become required cleanups, not
  optional.

### I2. GitHub-Pages-isms to undo

**Status:** open — now required (see I1: no Pages)

`gnp`'s `vite.config.js` uses `base: './'` and a **hash router** (`router.js`)
purely to survive GitHub Pages 404s. With Pages dropped (I1), on S3/CloudFront:
serve at root (`base: '/'`), switch to History-API routing, and configure a
CloudFront error-response fallback to `index.html`.

### I3. Inline theme script vs strict CSP

**Status:** resolved — CSP hash

Decision: keep `gnp`'s inline no-flash theme script and allow it via a **CSP hash**
(`script-src 'sha256-…'`) rather than a nonce. Fits a static S3/CloudFront site with
no dynamic response generation. Regenerate the hash whenever the inline script
changes (wire this into the build so it can't drift).

---

## Mechanical & dependency alignment

### M1. Web Awesome version

**Status:** resolved — use `gnp`'s flexible range

Decision: adopt `gnp`'s flexible latest range (`^3.11.0`) rather than the scaffold's
pinned `3.0.0-beta.4`. The committed `package-lock.json` still pins the exact resolved
version so `npm ci` stays reproducible in CI; the caret just allows routine updates.

### M2. Reconcile the two Workbox/PWA approaches

**Status:** resolved — use `gnp`'s `vite-plugin-pwa`

Decision: adopt `gnp`'s `vite-plugin-pwa`; **drop the scaffold's hand-rolled
`generateSW` script** (`scripts/generate-service-worker.mjs`) and its manual
`navigator.serviceWorker.register`. Weight is _not_ the deciding factor — both
approaches **are** Workbox (each pulls `workbox-build` and ships a `workbox-*.js`
runtime into the SW), so client bytes and `node_modules` weight are a wash. The
tiebreaker is owned code: the plugin removes the standalone build script, the manual
registration, and the hand-authored manifest, which fits the least-code ethos and the
wholesale `gnp` adoption. Follow-on work:

- **Port the offline-POST background-sync queue into the plugin's Workbox config.**
  This is the one capability not to lose: add a `workbox.runtimeCaching` entry
  mirroring the scaffold's `NetworkOnly` + `backgroundSync` block for the submit
  endpoint (`offline-submissions`, 24h retention). It is absent from `gnp`'s current
  `vite.config.js` only because `gnp` has no backend POSTs yet.
- **Manifest is generated, not hand-authored.** `vite-plugin-pwa` emits the web app
  manifest from its config, and `gnp` already declares it in `vite.config.js` (name,
  short_name, icons, theme/background color) — carry that over as-is.
- **Precache globs already cover fonts/icons.** `gnp`'s config sets
  `globPatterns: ['**/*.{js,css,html,woff2,png,svg}']`, so the self-hosted Quicksand
  woff2 and local icons (M3) precache for offline without extra work.
- **Keep `gnp`'s IndexedDB persistence** as the local source of truth — orthogonal to
  the service worker: background-sync replays network POSTs, IndexedDB holds the
  check/findings domain state. Both stay.

### M3. Carry over `gnp`'s offline/CSP wins

**Status:** resolved — carry both over

Decision: bring both across as-is. They are prerequisites for the CSP and offline
gates, not optional polish.

`gnp` already solved two problems the scaffold hasn't, both required by the CSP/offline
gates:

- Self-hosts Quicksand (woff2) and vendored the WA "awesome" theme with its CDN
  `@import` stripped — a naive `import webawesome.css` pulls CDN fonts that break
  offline and violate CSP.
- Registers a **local icon library** (`registerIconLibrary` + `public/icons/*.svg`);
  WA's `wa-icon` otherwise fetches from the Font Awesome CDN (breaks offline + CSP).

Bring both across regardless of other choices.

### M4. Workspace, tooling, and runtime alignment

**Status:** resolved — all of the below

- Merge `gnp` deps into the workspace `frontend/package.json`; drop `gnp`'s standalone
  lockfile. Vite is already aligned (both `8.2.1`).
- Node: align to `22` (this repo requires `>=22`; `gnp` CI used 20).
- Prettier: reformat the incoming `gnp` code to this repo's style (default
  semi/double-quote) — one reformat pass.
- ESLint: `gnp` has none; adopt this repo's flat config (per M5's JS-native lint setup).
- **Bring the `spike/transcribe` AudioWorklet spike and transcription docs over.**
  Rationale: once we migrate, all future work originates in this repo, so the spike and
  its design notes should live here (still not wired into Phase 1 — forward-looking).

### M5. Language: TypeScript → JavaScript + JSDoc

**Status:** resolved (planned)

Covered by [docs/js-and-jsdoc-migration-plan.md](js-and-jsdoc-migration-plan.md). `gnp`
is already all JS, but its JSDoc is thin (6 of 22 files carry any; the other 16 — all
12 components plus core infra like db/router/main — carry none), so the frontend does
**not** land green under `strict` +
`checkJs`. Land it with the checker **on but lenient** — `checkJs: true`,
`strict: false`, `// @ts-nocheck` as a greppable baseline on the noisy components — CI
green day one, then remove `@ts-nocheck` and ratchet toward `strict` one file per PR.

Keep `gnp`'s `*.templates.js` split; add a `@param` typedef to each exported template
so call sites are type-checked (shape in, string out) and a field rename breaks both
component and template. The HTML _interior_ stays unchecked — `lit-html`/`lit-analyzer`
is **rejected** (a runtime dep + framework layer against the no-framework/least-code
ethos, and interior checking isn't wanted).

---

## Suggested order

1. Decide D1–D3 (they gate real backend/auth work).
2. Land the JS+JSDoc change (M5) so the repo idiom matches the incoming code.
3. Bring the UI across: components + `gnp`'s offline/CSP wins (M3), reconcile PWA
   (M2), bump WA (M1), align tooling (M4), undo Pages-isms (I2), CSP for the theme
   script (I3). Use the file-level map in
   [`../gnp/docs/migration-port-manifest.md`](../../gnp/docs/migration-port-manifest.md)
   for exactly which files land where (carry-as-is vs transform vs don't-carry).
4. Build the backend contract and `sync.js` (D2) and wire auth (D1).
5. Add the frontend deploy stage (I1).
6. Confirm data classification and security review (D3) before production capture.
