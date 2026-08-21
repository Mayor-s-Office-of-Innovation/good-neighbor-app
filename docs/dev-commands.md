# Developer command reference

**Prereqs:** Node 22 LTS+, npm 10+. Terraform 1.9+ and pre-commit for infra work; AWS access is
for approved operators only — developers work through Git and CI. The backend local harness also
needs **JRE 17+** (DynamoDB Local + ElasticMQ are Java jars) — install with
`brew install --cask temurin` (not `java.com`'s Java 8), confirm `java -version` reports 17+. The
frontend, tests, lint, and typecheck do **not** need Java.

## One-time setup

| Command | Does |
|---|---|
| `npm install` | Install all workspace deps (run from repo root) |
| `cp .env.example .env.local` | Local backend env (git-ignored) — required by `npm run dev -w backend`. Dummies work out of the box; for the analyzer leg, set a real `ANALYZER_API_KEY` (see [Local S3 (MinIO)](#local-s3-minio)) |

## Repo-wide checks (what CI runs)

| Command | Does |
|---|---|
| `npm run format:check` | Prettier check |
| `npm run lint` | ESLint across workspaces |
| `npm test` | Vitest across workspaces |
| `npm run build` | Build all workspaces |
| `npm run typecheck -w backend` | `tsc` JSDoc typecheck (backend) |

## Frontend

| Command | Does |
|---|---|
| `npm run dev -w frontend` | Run the field app locally (Vite dev server) |

### Theme toggle (dark/light)

The dark/light theme toggle is hidden by default. Add the `?themeToggle` URL param to reveal it
(e.g. `http://localhost:5173/today?themeToggle`). It's per-load — the toggle shows only while that
param is in the current URL. OS-following theming still applies regardless of the param.

### Web Awesome AI agent skill

The UI uses [Web Awesome](https://webawesome.com) (`@awesome.me/webawesome`) for `<wa-*>` components.
The package ships Claude Code "agent skills" (a component reference + a design companion) inside
`node_modules` after `npm install`, so an AI agent can pull accurate component docs instead of
guessing. Register them once and they're available in future sessions:

```bash
npx skills add ./node_modules/@awesome.me/webawesome/dist/skills/webawesome
npx skills add ./node_modules/@awesome.me/webawesome/dist/skills/webawesome-design   # optional design companion
```

They install as symlinks (stay current on package updates); remove with `npx skills remove webawesome`.
See [Web Awesome → Agent Skills](https://webawesome.com/docs/ai/agent-skills).

The first screen asks for a provider-site code. With the local backend running, `123-456` is
seeded active and `000-000` seeded inactive.

### Clearing the local site binding

First run shows the site-setup ("code") screen and, once you confirm a site, writes a single
binding record to IndexedDB (database `conditions-reporter`, store `site`, key `current` — the
site name plus the setup code). To get the setup screen back, delete that one record
(surgical — leaves any saved checks intact):

- **DevTools:** Application → Storage → IndexedDB → `conditions-reporter` → `site` → right-click
  the `current` row → Delete, then reload.
- **Console:**
  ```js
  indexedDB.open('conditions-reporter').onsuccess = e =>
    e.target.result.transaction('site', 'readwrite').objectStore('site').delete('current');
  ```
  then reload.

To wipe everything (binding **and** saved checks) instead: `indexedDB.deleteDatabase('conditions-reporter')`
then reload. (The app holds an open connection, so a full delete may block until you reload or
close the tab — the surgical per-record delete above does not.)

## Backend local harness (Docker-free)

Runs the **exact Lambda handler + worker code** against local emulators (design rationale:
[ADR 0006](adr/0006-docker-free-local-dev-harness.md)). Ports: API **:3001**, DynamoDB Local
**:8000**, ElasticMQ **:9324**, GUI **:8001**, MinIO (local S3) **:9000** with its console on
**:9001**.

| Command | Does |
|---|---|
| `npm run dev -w backend` | **All-in-one:** DynamoDB Local + ElasticMQ + MinIO + API router + worker (self-bootstraps the table + queue + S3 bucket) |
| `npm run db:gui -w backend` | Browse the local table at http://localhost:8001 (run in a second terminal) |
| `npm run local:services -w backend` | Just the emulators (DynamoDB Local + ElasticMQ + MinIO) |
| `npm run local:minio -w backend` | Just MinIO (local S3, :9000; console :9001) |
| `npm run local:api -w backend` | Just the in-process API router (:3001) |
| `npm run local:worker -w backend` | Just the SQS→worker pump (dispatches analyze messages → analyze worker, others → submission worker) |
| `npm run local:bootstrap -w backend` | Create the table + queue only (normally not needed — `dev` self-bootstraps) |
| `npm run analyze:smoke -w backend` | Hand-run live analyzer smoke test (reads `backend/.env`, needs a real API key) |

### Local S3 (MinIO)

MinIO is the local stand-in for S3, so the presigned-PUT upload leg and the analyze worker's
read-back work without real AWS. On **first run** `local:minio` downloads the official MinIO
binary into `backend/.local/` (git-ignored, ~100 MB) — allow a moment. `ensureLocalInfra()` then
creates the `S3_UPLOAD_BUCKET`; the CORS that lets the browser's cross-origin PUT clear preflight
is set **globally** by the launcher via `MINIO_API_CORS_ALLOW_ORIGIN` (MinIO returns 501 for the
per-bucket `PutBucketCors` API, so bucket-level CORS is not used). Browse uploaded objects at the
console: **http://localhost:9001** (log in with the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
from your `.env.local`).

Two env notes (see [`.env.example`](../.env.example)):

- Those AWS creds double as MinIO's root user/password, so they must satisfy MinIO's rules —
  **user ≥ 3 chars, password ≥ 8 chars** (the committed dummies are `localdev` / `localdevsecret`).
  DynamoDB Local and ElasticMQ ignore creds, so this only matters because of MinIO.
- The analyze worker calls the **real deployed** analyzer, not a local one. Set `ANALYZER_BASE_URL`
  and a real `ANALYZER_API_KEY` in your `.env.local` for the analyzer leg to fire. Without a key
  the worker throws and the message redelivers — the upload/presign legs still work, so you can
  verify object-lands-in-MinIO independently.

> **Full media loop:** perimeter check → presigned `PUT` to MinIO → `register` enqueues to SQS →
> worker reads the object from MinIO, downscales + base64-encodes, calls the remote analyzer,
> and writes an `ANALYSIS#` item. Media reaches the worker only via the S3 key — never through
> the queue body.

### Exercise the loop

With `npm run dev -w backend` running, in another terminal:

```bash
# health check → {"ok":true,...}
curl -s localhost:3001/health

# POST a submission → 202 queued; flows curl → SQS → worker → DynamoDB
curl -s -X POST localhost:3001/submissions \
  -H 'idempotency-key: t1' -H 'X-Debug-Sub: dev' \
  -H 'content-type: application/json' -d '{"hello":"world"}'
```

Re-POSTing with the same `idempotency-key` flips the stored item's status to `duplicate_replay`
(the conditional-write replay branch). `X-Debug-Sub` stands in for the Cognito JWT `sub`.

> **No seed data yet.** A fresh `npm run dev` creates the table **empty** — there is no seed
> script (Phase 3 / Phase 8, not built). The GUI shows the table with zero items until you POST
> a submission through the loop (which writes a `SUBMISSION#…/#RECEIPT` receipt item).

**Teardown:** `Ctrl-C` in the `npm run dev` terminal stops all services cleanly (no orphaned
JVM/MinIO/node processes).

## Browse locally from phone

Use ```npm run dev:lan -w frontend```

This will print out IP address you can use from external phone to access the app on the same network as your machine that is running it