# Local S3 via MinIO (harness Step D)

**Status:** Implemented & verified — 2026-08-15. Landed the local S3 emulator and wired the
analyze worker into the local pump, closing the media path in the Docker-free harness. See also
[dev-commands.md → Local S3 (MinIO)](./dev-commands.md#local-s3-minio) for the command reference.

## Why MinIO, when the analyzer is remote

We call a **real deployed** analyzer with an API key — there is no local analyzer. But local S3 is
still required, because media never travels browser→analyzer directly. It takes three hops, two of
which are our own local code and both touch S3:

1. **Upload leg (browser → S3):** the frontend converts the photo data-URL to a Blob and does a
   presigned `PUT` straight to S3. Presign minted by [s3.js](../backend/src/s3.js) `presignPut`.
2. **Analyzer leg (worker → S3 → remote analyzer):** [analyze-artifact.js](../backend/src/workers/analyze-artifact.js)
   calls `getObjectBytes()` to read the bytes **back** from S3, downscales, base64-encodes, then
   calls the deployed analyzer with the API key and `store_input:false`.

So the remote analyzer removes the need for a *local analyzer*, not for *local S3*. S3 is the
handoff buffer between two local pieces; without it the presigned PUT has nowhere to land and the
worker's `getObjectBytes` has nothing to read.

## The full media loop

```
perimeter check
  → presign artifact (POST …/artifacts:presign)          [local API]
  → PUT bytes to MinIO (browser, presigned URL)           [upload leg]
  → register artifact (POST …/artifacts) → enqueue SQS    [local API]
  → worker reads object from MinIO, downscales+base64      [analyzer leg]
  → calls REMOTE analyzer with API key
  → writes ANALYSIS# item to DynamoDB
  → client polls GET …/checks/{id} until results land
```

Media reaches the worker **only via the S3 key** on the queue message — never through the queue
body. SQS decouples the fast register call from the slow analyzer call and gives retry/redelivery.

## What landed

| Change | File |
|---|---|
| MinIO launcher — downloads the binary to git-ignored `backend/.local/` on first run, spawns on `:9000` (console `:9001`), loopback-bound, sets global CORS | [local-minio.mjs](../backend/scripts/local-minio.mjs) *(new)* |
| Worker pump dispatches by message shape: `s3Key`+`artifactId` → `analyze-artifact.js`, else the demo `process-submission.js` | [local-worker.mjs](../backend/scripts/local-worker.mjs) |
| `forcePathStyle: true` when `AWS_ENDPOINT_URL_S3` is set (real AWS untouched) | [s3.js](../backend/src/s3.js) |
| Idempotent bucket create, gated on the MinIO endpoint being set | [ensure-infra.mjs](../backend/scripts/lib/ensure-infra.mjs) |
| `local:minio` script folded into `local:services` (so `dev` picks it up) | [package.json](../backend/package.json) |
| Env: `AWS_ENDPOINT_URL_S3`, MinIO-valid creds, `ANALYZER_*` | [.env.example](../.env.example) |
| Command reference + Local S3 section | [dev-commands.md](./dev-commands.md) |

## Two gotchas (why the design looks the way it does)

1. **MinIO returns `501 NotImplemented` for `PutBucketCors`.** It does not support the per-bucket
   CORS API. CORS is instead handled **globally** via `MINIO_API_CORS_ALLOW_ORIGIN=*`, set in the
   launcher ([local-minio.mjs](../backend/scripts/local-minio.mjs)). So `ensure-infra` only creates
   the bucket; it does **not** set CORS. Preflight was verified working regardless (see below).
2. **The AWS creds double as MinIO's root user/password**, so they must satisfy MinIO's rules —
   **user ≥ 3 chars, password ≥ 8 chars**. The old `local` / `local` password is too short and
   MinIO will refuse to start. `.env.example` now ships `localdev` / `localdevsecret`. DynamoDB
   Local and ElasticMQ ignore creds, so a single shared S3 client works against all three.

## How to run

```bash
npm run dev -w backend      # boots DynamoDB Local + ElasticMQ + MinIO + API + worker
                            # (self-bootstraps table + queue + bucket)
npm run dev -w frontend     # the field app
```

- MinIO console: **http://localhost:9001** — log in with `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` from your `.env.local`. Browse uploaded objects there.
- DynamoDB GUI: `npm run db:gui -w backend` → **http://localhost:8001** (a second terminal).
- First `dev` on a clean checkout downloads the MinIO binary (~103 MB) into `backend/.local/`
  (git-ignored); subsequent runs reuse it.

## Required `.env.local` edits (git-ignored, not committed)

Mirror the new keys from [.env.example](../.env.example) into your local file:

```
AWS_ENDPOINT_URL_S3=http://localhost:9000
AWS_ACCESS_KEY_ID=localdev            # >= 3 chars (MinIO root user)
AWS_SECRET_ACCESS_KEY=localdevsecret  # >= 8 chars (MinIO root password)
ANALYZER_BASE_URL=<deployed analyzer url>
ANALYZER_API_KEY=<real key>           # secret — local file only
```

Without the creds fix, **MinIO won't start**. Without a real `ANALYZER_API_KEY`, the upload/presign
legs still work but the analyzer leg throws and the message redelivers — handy for verifying
object-lands-in-MinIO independently of the analyzer.

## Verification performed (2026-08-15)

- `npm run lint`, `npm run typecheck -w backend`, `npm test -w backend` (79 tests) — all green;
  Prettier clean.
- **Live S3 seam** against a running MinIO, through the real [s3.js](../backend/src/s3.js) wrappers:
  bucket create → `presignPut` → `PUT` (200) → `getObjectBytes` read-back with matching bytes and
  content-type. Presigned URL host is `127.0.0.1:9000` (path-style), matching the browser origin.
- **CORS preflight**: `OPTIONS` from `Origin: http://localhost:5173` → **204** with
  `Access-Control-Allow-Origin: http://localhost:5173`, `Access-Control-Allow-Methods: PUT`,
  `Access-Control-Allow-Headers: content-type`.
- Not self-verified: the first-run binary **download** path (the binary was already cached on the
  test run). It reuses the proven fetch-and-stream pattern from the ElasticMQ launcher.

## Lane / handoff

- This session owned: MinIO, bucket bootstrap, the `s3.js` one-liner, and the analyze-pump wiring
  in `local-worker.mjs`.
- Peer session (`good-neighbor-app-ac`) owns [local-api.mjs](../backend/scripts/local-api.mjs)
  (full Step C surface already routed/verified against DynamoDB Local) and the frontend `api.js` +
  submit cutover. We meet at the queue.
- Commits are the user's to make — no commits were made by this session.
