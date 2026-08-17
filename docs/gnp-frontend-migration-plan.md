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
> **Still open / not started:** the design decisions that gate backend work — **D1**
> (auth / server-mediated analysis) and **D3** (data-classification security review) — and
> **I1** (frontend build→S3/CloudFront deploy stage). **D2 (backend contract) is resolved and
> built:** the online `api.js` shipped 2026-08-15 — there is **no `sync.js`**; the sync *system*
> is deferred with offline (see the D2 section + [frontend-api-wiring-plan.md](./archive/frontend-api-wiring-plan.md), now done & archived).
> **D4 (datastore) is resolved: DynamoDB** — see the section below. `transcribe`/`onboarding`
> remain **mocked**; the `analyzer` is now called through the backend (D2), not the local mock.
> See memory `step2-gnp-port-scope` for the exact landed state.

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
flow** — and (revised 2026-08-13 PM) the client uploads media to **our own S3 bucket** via a
**presigned PUT**, and our backend reads it back to feed the analyzer:

1. Client requests a **presigned PUT URL** from our **Lambda** and uploads each capture
   **directly to GNP's own S3 media bucket** (one object per artifact). Because the upload goes
   straight to S3, there is **no Lambda ~6 MB payload ceiling on media** — large photos/audio
   upload fine (the origin app's proven pattern). The Lambda records the returned S3 **key** on
   the artifact; the client never holds any AWS secret (the presigned URL is a scoped,
   short-lived capability).
2. Analysis runs **asynchronously**: registering an artifact enqueues an analyze job; a
   **worker** (in this repo) GETs the object from **our own bucket** using its **execution-role
   IAM** (same account — no presigned URL needed for ourselves), **downscales** it to ≤~1568px,
   **base64-encodes** it, and calls the **analysis API** — a **standalone shared service of ours
   on AWS** (own repo) — **once per artifact**, authenticating with an **API key** (`x-api-key`,
   held server-side in Secrets Manager; the key never leaves our backend). It sends
   **`storage.store_input:false` + `return_signed_urls:false`** so the analyzer keeps **no**
   copy — GNP owns the only copy of the media. (See the revised fork below.)
3. The worker **adapts + persists** the scorecard to DynamoDB (storing the S3 **key**, not the
   bytes); the client polls `GET /v1/checks/{checkId}` for results. The media **stays in our
   bucket** under an **S3 lifecycle rule (~7 days)** so **site admins can review the AI output
   against the source media**, then it auto-expires.

**Why our own S3 bucket (revised 2026-08-13 PM — reverses the 2026-08-13 "no S3 / base64 from the
client" design).** Media is uploaded by the client via **presigned PUT to a bucket GNP owns**, and
the backend reads it back to call the analyzer. Rationale:

- **Large uploads.** Presigned PUT goes client→S3 directly, so the **Lambda ~6 MB sync-payload
  ceiling no longer bounds media** (it did on the base64-through-Lambda design). This is the proven
  `../street-conditions` origin pattern (`POST /api/upload-url` → PUT → analyze reads the key).
- **Async falls out naturally.** S3 is the durable home a worker reads later — the analyze path is
  now **asynchronous** (enqueue on upload, worker processes), which is what we want.
- **Admin review against media (the product driver).** Keeping the media briefly lets **site admins
  review the AI scorecard against the source photo** — impossible under "no media at rest."
- **GNP owns retention.** Because the bucket is **ours**, we set the KMS key, tenant isolation, and
  an **S3 lifecycle rule (~7 days)** we can change at will — not coupled to the analyzer's
  evidence-bucket policy. Beaudry is separately defining the analyzer's retention (~1 week); ours is
  independent.

**The analyzer still never touches our bucket.** Bedrock (behind the analyzer) accepts **base64
sources only** — there is no URL/S3 input path (the `image_s3` idea was dropped) — so we give the
analyzer **no presigned URL and no cross-account IAM grant**. Our worker reads our own bucket with
its execution-role IAM, downscales to ≤~1568px (Bedrock's cap), and posts **base64 inline** with
`store_input:false`. Presigned URLs appear only at the **client upload** (PUT) and **admin review**
(on-demand GET) edges — never toward the analyzer.

**Cost of the reversal:** person-images **are now at rest** (~7 days) — so the data classification
goes back up and a photo-retention control is back in scope, but as a **declarative S3 lifecycle
rule**, not app-level delete code. Recorded in [security-review.md](security-review.md).

Client→backend hops (presigned-URL request + artifact register) are gated with API Gateway + WAF +
throttling (optionally a Cognito **Identity Pool** guest identity for IAM-authorized calls — still
no login). This is deterrence-grade, acceptable for a demo; real per-device identity arrives with v2
iPad provisioning. The **media bucket must be hardened** (block-public-access, SSE-KMS, TLS-only,
presigned PUT scoped to `content-type` + size, ~7-day lifecycle); residual controls also include
**no request/media-body logging**, analyzer-account **Bedrock invocation logging off**, and
**uploaded-media validation** (magic-byte + size + count caps) before the analyzer call.

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

What our backend persists (media in GNP's own S3 bucket; items store the keys — see D3), via a **caller-side adapter** that maps the
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
`gnp` client maps the scorecard → findings locally. The client↔backend transport is the
online **`api.js`** (shipped 2026-08-15); there is **no `sync.js`** — a background-sync
*system* (queue + `synced:false` reconciliation) is deferred **with offline** to post-MVP,
not built now. See [frontend-api-wiring-plan.md](./archive/frontend-api-wiring-plan.md) (done & archived).

**Who calls the analysis service? — resolved (server-mediated, base64 from our S3, async).** The
client uploads each capture to **our own S3 bucket** (presigned PUT); a **worker** reads the object
back, downscales + base64-encodes it, and calls our analyzer service (a standalone shared service of
ours on AWS) **once per artifact** with GNP's **consumer API key** (`x-api-key`, held in Secrets
Manager), sending `store_input:false` so the analyzer keeps no copy. Results are persisted and the
client polls for them. This is what makes caller-auth possible (only our backend holds the key) —
see **D1** for the full flow and the **GNP-owns-the-media** rationale (revised 2026-08-13 PM:
presigned PUT to our bucket for large-upload support + admin-review-against-media + a ~7-day
lifecycle; the analyzer still gets base64 only and never touches our bucket). It is the
server-mediated branch, chosen over client-direct because a public client can't be trusted to hold
the analyzer key.

Note: the data-layer shape is **DynamoDB items** (D4 resolved — see below).

### D3. Data classification — photos of people and hazards

**Status:** resolved — **media stored in GNP's own S3 bucket with a ~7-day lifecycle** (revised 2026-08-13 PM)

Decision: **store captured media in an S3 bucket GNP owns**, keep it briefly, and **auto-expire it
via an S3 lifecycle rule (~7 days)**. The items in DynamoDB store the **S3 keys**, never the bytes
(matches the [data model](dynamodb-data-model.md) R4). This reverses the interim 2026-08-13 "no
media at rest / base64-from-the-client" design.

**Why the reversal.** Three drivers (full rationale in D1):

- **Large-upload support** — presigned PUT client→S3 removes the Lambda ~6 MB media ceiling.
- **Admin review against media** — site admins can compare the AI scorecard to the source photo
  during the retention window; this is the product driver, and it's impossible with no media at rest.
- **GNP owns retention** — our bucket, our KMS key, our lifecycle window (changeable at will),
  independent of the analyzer's evidence-bucket policy.

This is also the **existing production norm**: the deployed origin app `../street-conditions`
stores media in S3 (presigned PUT → `uploads/…`) and reads it back for analysis.

**What is at rest, and for how long.** Person-images and audio live in our bucket for **~7 days**,
then an **S3 lifecycle expiration** (including noncurrent versions + delete markers) removes them —
a **declarative bucket rule, no app-level delete code**. DynamoDB keeps the **analysis document +
the S3 key** indefinitely (the scorecard is `sensitive` — conditions tied to a site — but not image
PII). Because media is now at rest, this is a **retention control back in scope** (it was removed
under the no-media design); see [security-review.md](security-review.md) for the classification and
controls.

**The analyzer keeps no copy.** Every analyzer call sends `storage.store_input:false` +
`return_signed_urls:false`, and the analyzer receives **base64 our worker produced from our bucket**
— it is never given a presigned URL or IAM access to our bucket (Bedrock accepts base64 sources
only; there is no S3/URL input path). So the **only** durable copy of the media is in **our** bucket,
under **our** lifecycle rule.

Consequences and things that must hold:

- **Media bucket hardening (now in scope):** block-public-access, SSE-KMS (app key), TLS-only,
  Lambda/worker-role-only access, presigned PUT scoped to `content-type` + size, and the **~7-day
  lifecycle rule** as the backstop that actually delivers "not kept forever." Get the lifecycle
  right or the retention property is fiction.
- **No incidental second copy.** Do not put media bytes on SQS (enqueue the **S3 key**, not the
  bytes), do not log the base64 (CloudWatch), and keep analyzer-account Bedrock model-invocation
  logging off so request images aren't captured there.
- **Admin review is served via on-demand presigned GET** minted by our Lambda — the browser never
  gets long-lived bucket access.
- **On-device: no photo/audio bytes are persisted.** `gnp` holds captured photo/audio Blobs **in
  memory only** for the duration of a walk (component state + the `check-session` singleton) and
  discards them after upload. Only capture **metadata** (`kind`, `size`, note text, transcript) and
  the scorecard are written to IndexedDB (the `checks` store) — no image/audio bytes at rest
  on-device, so there is no local media-retention policy to set.
- **Level 3 check:** person-images are now at rest (briefly). Confirm with security that a short,
  access-controlled, auto-expiring retention window in our own KMS-encrypted bucket keeps the
  classification acceptable for the testing phase, and record it in
  [docs/security-review.md](security-review.md).

### D4. Database — DynamoDB vs managed Postgres (RESOLVED → DynamoDB)

**Status:** resolved — **DynamoDB** replaces managed Postgres/Prisma (2026-08-13)

We adopted **DynamoDB instead of managed Postgres/Prisma** for the cloud database. The full
analysis lives in the DynamoDB planning set — [decision](dynamodb-database-decision.md),
[data model](dynamodb-data-model.md) — and is recorded in
[ADR 0002](adr/0002-datastore-dynamodb.md).

What the decision changed (the cutover, now done in docs):

- [AGENTS.md](../AGENTS.md) and [ADR 0001](adr/0001-architecture-stack.md) previously specified
  managed Postgres + Prisma. AGENTS.md now names DynamoDB, and ADR 0001's datastore choice is
  superseded by ADR 0002. Prisma is removed from the backend (Phase 2 cutover).
  (The `web-dev` skill default was already DynamoDB, so this reverts to the skill default.)
- Access patterns are DynamoDB-friendly — everything is site-scoped and time-ordered
  (single-table `SITE#<siteId>` partition, time-sortable sort keys), with citywide reporting
  served by a CQRS read plane (GSIs + a Streams-fed analytics lake). No relational joins.

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

Covered by [docs/js-and-jsdoc-migration-plan.md](archive/js-and-jsdoc-migration-plan.md). `gnp`
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
4. Build the backend contract and the online `api.js` (D2 — no `sync.js`; sync system deferred with offline) and wire auth (D1).
5. Add the frontend deploy stage (I1).
6. Confirm data classification and security review (D3) before production capture.
