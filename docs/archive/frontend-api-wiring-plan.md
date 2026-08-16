# Plan: wire the field app to the backend (online `api.js`, no sync system)

**Status:** Done (MVP) — 2026-08-15, closed out 2026-08-16 → **archived**. The online write+read cutover shipped and is green (typecheck + `vite build`); the `create → complete → list → get` slice is verified against DynamoDB Local. The in-browser **photo-upload leg is verified end-to-end (2026-08-16)** — presign → `PUT` to MinIO → register → SQS → worker → the **deployed analyzer** → `ANALYSIS#` + `TASK#` items, driven from the real screens. **All MVP as-built gaps are now closed (2026-08-16):** the worklist reads real `listTasks` and hazard triage reads the authoritative `TASK#.type` (the client-side escalation mirror was deleted). The only remaining item — a deterministic **confidence %** placeholder in results — is explicitly **post-MVP**; see [Known gaps](#known-gaps-as-built).
**Depends on:** analysis-backend Lambdas Step C endpoints ([plan](../analysis-backend-lambdas-plan.md)) — **built and routed** (handlers in [checks.js](../../backend/src/handlers/checks.js) / [artifacts.js](../../backend/src/handlers/artifacts.js), wired into [local-api.mjs](../../backend/scripts/local-api.mjs)).
**Grounds in:** [D2 backend contract](../gnp-frontend-migration-plan.md) · [data model](../dynamodb-data-model.md)

## Decision

The field app talks to the backend with a **thin online API client** (`api.js`) — plain
request/response — **not** a sync layer. Writes happen when the user acts; reads happen when a
screen loads; the in-progress walk stays local.

### Decisions locked (2026-08-15)

- **Full cutover to the backend** (not config-flagged coexistence): `api.js` replaces the mock
  analyzer + local `checks` persistence. When the backend is unavailable, **show an error** —
  no silent local fallback, no standalone demo mode for the submit/review path.
- **Verifiable slice first:** build `api.js` fully + wire the local router routes, then
  wire and **verify `create → complete → list → get` end-to-end against DynamoDB Local**. Wire
  the photo-upload leg (presign → PUT → register). **MinIO landed 2026-08-15 (harness Step D)**
  and the S3 seam is verified through the real `s3.js` wrappers — presign → PUT (200) →
  worker read-back match, cross-origin preflight 204. The full browser-driven upload leg is
  **now verified end-to-end (2026-08-16)** against the deployed analyzer, with a real
  `ANALYZER_API_KEY` + `AWS_ENDPOINT_URL_S3` in `.env.local`. See
  [minio-local-s3.md](../minio-local-s3.md).
### Blockers cleared — fileset re-review (2026-08-15)

Both gates the "locked" decisions waited on are now resolved:

- **Native-camera capture rework — LANDED, and it was a capture-UX change only, *not* a data
  model change.** [perimeter-check.js](../../frontend/src/components/perimeter-check.js) now opens
  the device camera via a hidden `<input type="file" accept="image/*" capture="environment">`,
  but the picked file is still read to a **JPEG data-URL** (`FileReader.readAsDataURL`) and
  stored inline on the item as `item.dataUrl` — exactly as before. The whole app still renders
  from `dataUrl` (review, shot grid, results). So the feared "how does a photo become the blob
  for the PUT" question never materialized: **api.js converts the item's data-URL → `Blob` for
  the presigned PUT** (`await (await fetch(dataUrl)).blob()`), a one-liner. Nothing about the
  wiring is blocked on capture anymore.
  - *Orphan to clean up:* [capture-photo.js](../../frontend/src/components/capture-photo.js) is a
    standalone element that exposes a real `File` blob but is **referenced nowhere** — dead code
    left from an earlier draft. **Deleted 2026-08-15** (housekeeping folded in with the cutover).
- **Step C handlers exist and are routed.** The endpoint contract below is **confirmed against the
  real handlers** (was "proposed"), and they're now wired into the local router
  ([local-api.mjs](../../backend/scripts/local-api.mjs)) alongside `POST /submissions` + `GET /health`,
  so `create → complete → list → get` verifies against DynamoDB Local.

## Why (this is a simplification, not new scope)

A sync **system** — the `synced:false` flag + a background queue that drains and reconciles —
exists for exactly one reason: to make writes survive being **offline**. Offline is deferred to
post-MVP ([MVP-TODO.md](../MVP-TODO.md) → Offline / Workbox). So the sync system defers *with*
it. Online-only needs only request/response: on network failure we surface an error, because
offline is out of scope. The imagined `sync.js` (queue + `synced:false` + drain) is replaced by
`api.js` (POST/GET + one short poll).

## What goes where

| Data | Home | When it moves |
|---|---|---|
| In-progress walk (draft + photo data-URLs) | **Local** (IndexedDB `draft`) | never leaves the device — it's working state; a mid-walk reload resumes from it |
| Site binding (device↔site) | **Local** (IndexedDB `site`) | stays local for the demo (real version derives `siteId` server-side from auth) |
| Submitted check + artifacts + analysis + tasks | **DynamoDB** (via backend) | **written on submit**, **read on load** |
| Submitted-checks cache (IndexedDB `checks`) | **Optional** | can be dropped once checks are read back online; the `synced:false` flag goes away |

## The flow

- **Write (on submit):** create check → presigned-PUT each photo to S3 → register artifacts
  (enqueues async analysis) → complete. Awaited calls; on failure, show an error and let the
  user retry. No local queue.
- **Read (on load):** today's checks (AP6) and the worklist (AP10) are fetched when those
  screens open. **This is the whole "fleet" story** — a task created on one device shows up on
  another the next time it loads. For a 3×/day cadence, pull-on-load is sufficient; **no
  push/WebSocket/polling engine.**
- **One async caveat:** analysis runs async (worker → analyzer), so after submit the client
  **polls that one `checkId`** until results land. A short-lived poll scoped to the submit flow
  — not a general sync engine.

## Endpoint contract (client view)

**Confirmed against the Step C handlers (2026-08-15)** — shapes below are read straight from
[checks.js](../../backend/src/handlers/checks.js) / [artifacts.js](../../backend/src/handlers/artifacts.js),
not proposed. Two invariants hold throughout: `siteId` is **server-derived from the principal,
never sent by the client**; the client **mints `checkId` and sends it as the `idempotency-key`
header** (not in the body), so every write is safely replayable. (The app already mints an id —
`newId()` = `crypto.randomUUID()` in [db.js](../../frontend/src/db.js); a ULID isn't required in
practice because `listChecks` orders by `startedAt` via GSI1, not by id.)

| `api.js` call | Method + route | Request | Response |
|---|---|---|---|
| `createCheck` | `POST /v1/checks` · header `idempotency-key: <checkId>` | body `{ sides? }` (optional) | `201 { checkId, status:"in_progress", startedAt }` · replay → `200 { checkId, status:"in_progress" }` (`startedAt` is **server-assigned**) |
| `presignArtifact` | `POST /v1/checks/{checkId}/artifacts:presign` | `{ side, contentType }` (contentType ∈ image/jpeg,png,webp) | `200 { artifactId, side, s3Key, contentType, uploadUrl, expiresIn }` |
| *(browser)* upload | `PUT {uploadUrl}` (S3) · header `Content-Type: <contentType>` | raw image bytes — `await (await fetch(item.dataUrl)).blob()` | `200` (no body) |
| `registerArtifact` | `POST /v1/checks/{checkId}/artifacts` | `{ artifactId, side, s3Key, contentType, capturedAt, text? }` (s3Key must start `checks/<siteId>/<checkId>/`) | `202 { artifactId, status:"queued" }` · `409` if already registered |
| `completeCheck` | `POST /v1/checks/{checkId}/complete` | — (checkId in path) | `200 { checkId, status:"completed", grade, issueCount, maxSeverity, taskCount }` |
| `listChecks` | `GET /v1/checks?limit&nextToken` | — (cursor paging, **not** from/to) | `200 { checks: [<header items>], nextToken? }` (newest `startedAt` first) |
| `getCheck` (poll) | `GET /v1/checks/{checkId}` | — | `200 { check, artifacts[], analyses[] }` · `404` if absent — done when `check.status==="completed"` and every artifact has a matching analysis |
| `getMediaUrl` (admin) | `GET /v1/checks/{checkId}/artifacts/{artifactId}:media` | — | `200 { artifactId, s3Key, downloadUrl, expiresIn }` |
| `listTasks` (worklist) | `GET /v1/tasks?status&limit` | — | `200 { tasks: [...] }` (GSI2, most-severe first) — **route exists** ([local-api.mjs](../../backend/scripts/local-api.mjs)); **wired to the worklist UI 2026-08-16** ([today-view.js](../../frontend/src/components/today-view.js)) |

> **Shape deltas from the earlier proposal** (adjust `api.js` accordingly): status strings are
> `in_progress` / `completed` (underscore, not hyphen); presign returns `s3Key` (not `key`) and
> takes no `size`; register returns `status:"queued"` (not `"analyzing"`); complete returns
> `issueCount` / `maxSeverity` (not a `categoryRollup[]`); getCheck's header key is `check`
> (not `header`); list paging is `limit` + opaque `nextToken` (not `from`/`to`).

> **Gap closed (2026-08-15):** the **tasks-list** route (AP10, GSI2) now exists —
> `GET /v1/tasks?status&limit` routed in [local-api.mjs](../../backend/scripts/local-api.mjs), and
> `listTasks` is written in `api.js`. **Follow-through closed (2026-08-16):** the worklist screen
> ([today-view.js](../../frontend/src/components/today-view.js)) now renders real `listTasks` items —
> see [Known gaps](#known-gaps-as-built).

## Scope

**Build (new — frontend):**
- `api.js`: `createCheck` / `uploadArtifact` (presign → PUT → register) / `completeCheck`,
  `listChecks` (AP6), `getCheck` (poll for results). Shapes per the confirmed contract above.
  `listTasks` (AP10) is written against the intended shape but stays dormant until the route exists.
- Rework the analyzer swap seam: [submit-check.js](../../frontend/src/services/submit-check.js) is
  the whole seam today — it calls the **mock** `analyzeCheck()`, derives findings, and writes a
  self-contained record to IndexedDB `checks` with `synced:false`. Full cutover replaces that
  body with the api.js write sequence (create → per-photo presign/PUT/register → complete →
  poll `getCheck`), surfacing an error on any failure instead of falling back to local.
- Wire `/today` + history reads → `listChecks`/`getCheck`; wire the worklist → `listTasks` once
  its route lands.

**Backend integration task (in the backend lane, but gates the local slice):** — **Done (2026-08-15).**
- The Step C handlers are routed into [local-api.mjs](../../backend/scripts/local-api.mjs), and
  `create → complete → list → get` is verified against DynamoDB Local.

**Deferred code cleanups (housekeeping, folded in with the cutover):**
- **Done** — dropped the `synced:false` flag + the "later sync layer drops in" comment in
  [db.js](../../frontend/src/db.js) (rewritten to the online-only narrative), and reworked the
  `synced:false` write out of [submit-check.js](../../frontend/src/services/submit-check.js).
- **Partial** — the IndexedDB `checks` store is off the submit/read path (submitted checks are
  read online), but it's **retained** as demo/seed scaffolding ([demo/seed.js](../../frontend/src/demo/seed.js)),
  not demoted. Reshaping seed to the backend-read model is tracked in the design-trim plan.
- **Done** — deleted the orphaned `capture-photo.js` (was referenced nowhere).
- **Done** — fixed the [gnp-frontend-migration-plan.md](../gnp-frontend-migration-plan.md) D2 framing so
  `sync.js` reads as **`api.js` (online), sync system deferred with offline** (all three references).

**Explicitly not building:** background-sync queue, `synced:false` reconciliation, real-time
push. Those return only if/when offline does — same concern, deferred together.

## Done when

`api.js` exists; submitting a walk writes `SITE#/CHECK#` items through the backend; reopening
`/today` (or another bound device) shows checks/tasks read from DynamoDB; results appear after
the post-submit poll. No `synced:false`, no queue.

**Met (2026-08-15)** for the write+read slice — `api.js` exists, `/today` and results read from
DynamoDB, no `synced:false`/queue. The photo-carrying submit path (write → presigned PUT → worker →
analysis → poll) is **now also verified end-to-end in the browser (2026-08-16)** against the deployed
analyzer — the harness needed a MinIO-enabled `.env.local` (`AWS_ENDPOINT_URL_S3` + a real
`ANALYZER_API_KEY`; see [minio-local-s3.md](../minio-local-s3.md)). All acceptance criteria met.

## Known gaps (as-built)

Shipped code that intentionally stands in for post-MVP behavior — correctly commented in-code,
surfaced here and in [MVP-TODO.md](../MVP-TODO.md) so a reader finds them from the docs, not only
the source:

- **Confidence % is a placeholder.** [check-results.js](../../frontend/src/components/check-results.js)
  renders a deterministic, representative confidence per finding (no live scoring in this build);
  it reads clearly as an estimate. Real per-finding confidence is post-MVP.

### Closed (2026-08-16)

- **~~Worklist is still MOCK.~~ Closed.** [today-view.js](../../frontend/src/components/today-view.js)
  now renders "open items" from the site's real `TASK#` items via `listTasks` (AP10), split by the
  backend-stamped `type` (`city_escalation` → 311, `onsite` → staff), most-severe-first from the
  GSI2 query. The representative 311 lifecycle (ticket #, status, reported-time, resolve buttons) is
  gone — cards show only real fields (category, severity word, flagged time), since the ticket
  lifecycle + resolve flow are post-MVP.
- **~~Hazard triage is mirrored client-side.~~ Closed.** The client-side escalation mirror
  (`ESCALATION_HINTS` + severity ≥ 3) is **deleted** from
  [check-adapter.js](../../frontend/src/domain/check-adapter.js). Every consumer (today-view
  worklist + donut/last-log, check-results buckets, submit-check just-submitted findings) now reads
  the authoritative `TASK#.type` — the adapter reduces the site's tasks to the set of
  city-escalation categories per check (`cityCategoriesByCheck`/`cityCategoriesForCheck`) and a
  finding is a "city action" iff its category is in that set. No client copy of the escalation rule
  remains to drift from the backend.
