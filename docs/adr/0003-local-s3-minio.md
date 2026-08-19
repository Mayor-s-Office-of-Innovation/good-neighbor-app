# ADR 0003: Local S3 via MinIO in the Docker-free Dev Harness

## Status

Accepted (2026-08-15). Applies to local development only; real AWS S3 in dev/prod is
unchanged. Operational how-to (run commands, `.env.local` keys, console login, the media
loop) lives in [dev-commands.md → Local S3 (MinIO)](../dev-commands.md#local-s3-minio) — this
record captures only the decision and its rationale.

## Context

The backend runs in a **Docker-free** local harness (DynamoDB Local + ElasticMQ as JVM jars,
an in-process API router + worker; see
[local-dev-environment-plan.md](../archive/local-dev-environment-plan.md)). Media analysis
calls a **real, deployed** analyzer over an API key — there is no local analyzer.

The non-obvious point: a remote analyzer removes the need for a local *analyzer*, **not** for
local *S3*. Media never travels browser → analyzer directly; it takes two local hops that both
touch S3:

1. **Upload leg** — the frontend converts the photo to a Blob and does a presigned `PUT`
   straight to S3 (`presignPut` in [s3.js](../../backend/src/s3.js)).
2. **Analyzer leg** — [analyze-artifact.js](../../backend/src/workers/analyze-artifact.js)
   reads the bytes **back** from S3 (`getObjectBytes`), downscales, base64-encodes, then calls
   the deployed analyzer with `store_input:false`.

S3 is the handoff buffer between two local pieces. Without it the presigned PUT has nowhere to
land and the worker has nothing to read — so the harness needs an S3 stand-in.

## Decision

Use **MinIO** as the local S3 emulator, launched by a node script
([local-minio.mjs](../../backend/scripts/local-minio.mjs)) that downloads the binary to
git-ignored `backend/.local/` on first run, binds loopback `:9000` (console `:9001`), and folds
into `local:services` so `npm run dev` picks it up. It is reached through the **same AWS SDK S3
client** with `forcePathStyle: true` when `AWS_ENDPOINT_URL_S3` is set (real AWS is untouched);
bucket bootstrap is idempotent in `ensure-infra`.

## Alternatives considered

- **Mock/stub S3 in app code** — would bypass the real `s3.js` wrappers and the presign/CORS
  path, so it would not actually prove the seam we ship.
- **LocalStack** — container-based, which reintroduces the Docker dependency the harness
  deliberately avoids.
- **Require real AWS S3 for local dev** — needs credentials + network and breaks the
  offline, scales-to-zero local iteration model.

## Consequences

- **CORS is global, not per-bucket.** MinIO returns `501 NotImplemented` for `PutBucketCors`,
  so CORS is set globally via `MINIO_API_CORS_ALLOW_ORIGIN` in the launcher; `ensure-infra`
  only creates the bucket. Preflight was verified (`OPTIONS` → `204`).
- **AWS creds double as MinIO's root user/password**, so they must satisfy MinIO's rules
  (**user ≥ 3 chars, password ≥ 8 chars**). Committed dummies are `localdev` / `localdevsecret`.
  DynamoDB Local and ElasticMQ ignore creds, so one shared S3 client works against all three.
- **First run downloads the ~103 MB MinIO binary** into git-ignored `backend/.local/`; later
  runs reuse it.
