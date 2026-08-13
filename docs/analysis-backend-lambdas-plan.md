# Plan: Analysis-Backend Lambdas (perimeter-check API + server-mediated analyze)

*Build plan · [index](./README.md) · grounded in [D1/D2](./gnp-frontend-migration-plan.md) ·
builds on [data model](./dynamodb-data-model.md) · reconciles with
[buildout Phase 2](./dynamodb-buildout-plan.md)*

**Status:** Proposed — runnable build plan · **Date:** 2026-08-13 · **Owner:** team

This is the missing build doc for the seam that turns a captured perimeter check into persisted,
scored, per-site data. The **direction** is fully decided across D1 (server-mediated, **presigned
PUT to GNP's own S3 bucket** → worker reads it back → base64 to the analyzer, async), D2
(perimeter-check system of record + caller-side adapter), D3 (**media at rest in our bucket, ~7-day
lifecycle**), and the data model (`SITE#`/`CHECK#` items store S3 keys); what has been missing is a
phased plan that says *which Lambdas, which routes, which items, in what order*. That is this doc.

> **✅ Media-handling decided (2026-08-13 PM) — GNP owns the bucket; analyzer gets no S3 access.**
> The earlier "no media at rest / base64 posted from the client" premise is **reversed**. Media is
> uploaded via **presigned PUT to a bucket GNP owns**, a **worker reads it back** (its own
> execution-role IAM — same account), downscales + base64-encodes, and calls the analyzer with
> `store_input:false`. An **S3 lifecycle rule expires media after ~7 days**. Why:
> - **Large uploads** — presigned PUT client→S3 removes the Lambda ~6 MB payload ceiling on media
>   (the binding limit under the old base64-through-Lambda design). Matches the **deployed** origin
>   app `../street-conditions` (presigned PUT → `uploads/…`; analyze reads the key).
> - **Async falls out naturally** — S3 is the durable home the worker reads later (Aaron: "we want
>   this to run async").
> - **Admin review against media** — the product driver: site admins compare the AI scorecard to the
>   source photo within the retention window.
> - **GNP owns retention** — our bucket, our KMS key, our lifecycle window (changeable at will),
>   independent of the analyzer's evidence-bucket policy (Beaudry's ~1-week rule is separate).
>
> **The analyzer never touches our bucket:** Bedrock accepts **base64 sources only** (no URL/S3
> input — `image_s3` was dropped), so the analyzer gets **no presigned URL and no cross-account IAM
> grant**; our worker produces the base64. The rubric is still in flux (Beaudry), so the
> adapter/classification stays rubric-driven — but the media architecture below is settled.

## What this plan covers

1. **The server-mediated analyze path** (D1/D2/D3): client uploads media via **presigned PUT to
   GNP's own S3 bucket** → registers the artifact (enqueues an analyze job) → a **worker** GETs the
   object from our bucket, downscales + base64-encodes, calls the analyzer **once per artifact**
   with the server-held API key (`store_input:false`) → adapts the scorecard → persists `ARTIFACT`
   (with S3 key) + `ANALYSIS` items → client polls for results. **Async**, media at rest in our
   bucket under a ~7-day lifecycle.
2. **Perimeter-check CRUD/list + upload endpoints** that replace the generic `POST /api/submissions`:
   create/start a check, presign an upload, register/analyze an artifact, complete a check, list a
   site's checks, fetch one check, mint a presigned GET for admin review.
3. **DynamoDB read/write handlers** for the `SITE#`/`CHECK#` item shape — growing the interim
   `SUBMISSION#<requestId>/#RECEIPT` receipt (Phase-2 as-built) into the real check header +
   artifacts + analyses + tasks.
4. **Analyzer-consumer auth provisioning** (revised 2026-08-13): GNP's analyzer **API key in
   Secrets Manager** (Terraform), Lambda role granted read, fetch-and-cache in the analyze
   handler, sent as **`x-api-key`** (confirmed against the contract), TLS-only.

## What this plan does NOT cover (tracked elsewhere)

- **Standing up the analyzer service itself** — external dependency, Beaudry's repo
  (`../street-conditions-analysis`), shipped to AWS separately. This plan builds *against its
  contract* and can be developed + unit/integration-tested behind a stub before it deploys; only
  the live end-to-end proof waits on it + an issued consumer key. — [MVP-TODO](./MVP-TODO.md)
- **IAM tenant isolation / device-as-site (Option 3)** — Phase 6. Here we build the
  **server-derives-`siteId`** seam so the real principal drops in later without reshaping handlers;
  in the demo the principal is deterrence-grade. — [security-review.md](./security-review.md)
- **Citywide reporting API + Tier-1 KPI reads** — its own plan + buildout Phases 4–5.

---

## Ground truth: the analyzer contract

Pinned from `../street-conditions-analysis/contract/` (openapi.yaml + JSON schemas) as of
2026-08-13. **The service owns the rubric and data format; we adapt to it, never the reverse.**

- **Endpoint:** `POST /v1/analyses` · **Auth:** `x-api-key` header · **TLS-only** ·
  host will be `https://analysis.streetconditions.org` (confirm the GNP-consumed URL at issue-time).
- **Request** (`analysis-request.schema.json`): `{ rubric_id, rubric_version?, input, storage?, caller? }`
  where `input` is `oneOf`:
  - image: `{ type:"image", images:[{ content_type:"image/jpeg|png|webp", base64 }] }`
  - text: `{ type:"text", text }` (min length 5)
  - **We always send `storage:{ store_input:false, return_signed_urls:false }`** so the analyzer
    keeps no copy. `caller.request_id` = our `checkId#artifactId` for traceability;
    `caller.app_id` is **not trusted for authz** (the API key is the identity).
- **Rubric:** `rubric_id="street-conditions"`, `rubric_version="1.0.0"` — **12 categories**,
  `severity` **0–5** as of this pin. **⚠ The rubric is actively changing** — Beaudry is modifying
  it alongside the analyzer work, so category IDs, category *count*, and possibly the severity band
  are all **in flux**. Treat every rubric specific in this doc as a *snapshot*, not a constant:
  build the adapter and classification **rubric-driven** (see below), never keyed to today's 12 IDs
  or a 0–5 band, and **re-pin the contract fixtures when the rubric stabilizes**. The
  `GET /v1/rubrics` + `GET /v1/rubrics/{id}/versions/{version}` endpoints expose the live category
  set/scale, so the count/scale can be discovered rather than hard-coded.
- **Response** (`analysis-response.schema.json`): `{ analysis_id, rubric:{id,version,output_mode},
  created_at, model, input_storage, result:{ summary, categories:[…] } }`. Each category:
  `{ category_id, label, severity(0–5), severity_label, description, hazard_detected,
  evidence_indices, confidence?, raw_model_category? }`.
- **Error codes we must handle:** `400` invalid request, `401` bad/missing key, `403` rubric not
  allowed, `413` `input_too_large` (downscale further), `422` invalid model response, `429`
  `model_throttled` (**retry w/ exponential backoff**), `502` model invocation failed.

### The adapter (service scorecard → our persisted shape)

A **caller-side adapter** (D2) maps the service response to our per-artifact `ANALYSIS`
projection. Mapping (fixed by D2):

| service field | our field | note |
|---|---|---|
| `result.categories[].label` | `category` | |
| `result.categories[].severity` | `rating` | 0–5, rubric-owned scale |
| `result.categories[].hazard_detected` | `hazard` | |
| `result.categories[].description` | `explanation` | |
| `result.categories[].evidence_indices` | `evidence_indices` | per-call; check-level attribution is by artifact |
| `rubric.version` | `rubricVersion` | **stamp on every ANALYSIS item** — never mix scales in a rollup |
| `confidence` | — | **dropped** (D2) |

We **do not** persist `total_score`/`status_label` — the service doesn't return them and we
**compute them at read** in the shared `scoring` module (matches "raw components, compute at read").

**Adapter must not assume a category set.** Since the rubric is changing, the adapter maps
*whatever categories the response carries* (iterate `result.categories[]`) rather than expecting a
fixed 12 or fixed IDs. Persist the count as-returned and stamp `rubricVersion`; the `scoring`
module derives any aggregate max from the *number of scored categories in that version* (the
service README makes this explicit: "any aggregate maximum must be derived from the number of
scored categories in the selected rubric"). A category-set change is then a rubric-version bump,
not a code change.

**Check-level synthesis** (for the UI's single scorecard): per category, take the **max `rating`
and OR of `hazard`** across the check's artifacts; attribute each finding to its **source
artifact** (not the model's per-call `evidence_indices`). Documented fallback if the analyzer
usage-plan quota bites: batch-per-modality (one call for all a check's photos), losing per-photo
attribution.

---

## Architecture: async analyze via a worker reading from S3 (decided 2026-08-13 PM)

**Decided (was the one open design point).** The analyze path is **asynchronous**, built on the
existing SQS worker — now reading media from **GNP's own S3 bucket**. This reverses the interim
"synchronous analyze, worker off the MVP path" recommendation, which only held under the
now-abandoned no-media-at-rest design (there was no durable media to reconcile later). With media in
S3, async is the natural shape (Aaron: "we want this to run async"), and the media never rides the
queue — **only the S3 key does** (D3: no media bytes on SQS).

**The flow:**

- **`POST /v1/checks/{checkId}/artifacts:presign`** returns a **presigned PUT URL** + the S3 key +
  `artifactId`. The client uploads the bytes **straight to S3** (large uploads OK — no Lambda
  payload ceiling).
- **`POST /v1/checks/{checkId}/artifacts`** registers the artifact (writes the `ART#` item with the
  **S3 key**, conditional on the parent check existing + same-principal ownership) and **enqueues an
  analyze job** (`{ siteId, checkId, artifactId, s3Key }` — the key, never the bytes). Returns `202`.
- **The worker** (`process-submission`, repurposed / a sibling `analyze` worker) drains the queue:
  GET the object from **our bucket** (execution-role IAM), downscale to ≤~1568px, base64-encode,
  call the analyzer **once per artifact** with `store_input:false`, adapt, write the `ANALYSIS#`
  item, and update the check's rollup counters.
- **The client polls `GET /v1/checks/{checkId}`** for artifacts + analyses as they land; `complete`
  synthesizes the check-level scorecard + tasks once all artifacts are analyzed.

**The existing SQS worker is back ON the MVP path.** It was built for the offline-replay model (M2);
here it becomes the analyze worker. The `SUBMISSION#/#RECEIPT` idempotency-receipt shape is
superseded by the real `CHECK#`/`ART#`/`ANALYSIS#` items; whether to keep a receipt for the
post-MVP offline-replay model is a **post-MVP** call — flag, don't resolve here.

- **Idempotency** lives on the check items: create-check is a conditional `Put`
  (`attribute_not_exists(pk) AND attribute_not_exists(sk)`) on the `CHECK#` header keyed by the
  client ULID `checkId`; artifact registration is conditional on the parent check existing and being
  owned by the same principal (no grafting — security-review hardening); the analyze job is
  idempotent on `checkId#artifactId` so a redelivered SQS message can't double-write an `ANALYSIS#`.

> **Trigger choice (impl detail).** The artifact-register endpoint enqueues explicitly (recommended
> — the `ART#` item is the authoritative record and carries the metadata the worker needs). An S3
> `ObjectCreated` event notification could enqueue instead, but then the item write and the upload
> race; prefer register-then-enqueue.

---

## Endpoint surface (replaces `POST /api/submissions`)

All under a versioned base (`/v1`). `siteId` is **server-derived from the principal**, never from
the body (security-review invariant); in the demo the principal is deterrence-grade, in Phase 6 it
is the device-as-site STS claim — the handler code is identical.

| Route | Handler | DynamoDB / AWS | Access pattern |
|---|---|---|---|
| `POST /v1/checks` | create/start a check | `Put` `SITE#/CHECK#` header, conditional on `checkId` | AP5 |
| `POST /v1/checks/{checkId}/artifacts:presign` | mint a **presigned PUT** URL for one artifact | S3 `getSignedUrl` (PUT, scoped) — no DB write yet | — |
| `POST /v1/checks/{checkId}/artifacts` | register artifact + **enqueue** analyze job (async) | `Put` `ART#` (S3 key), conditional; `SendMessage` (key only) → `202` | AP8 |
| *(worker)* `analyze` | drain queue: GET S3 → downscale → base64 → analyzer → persist | analyzer call → `Put` `ANALYSIS#` + `Update` header counters | AP8 |
| `POST /v1/checks/{checkId}/complete` | finalize check | synthesize scorecard → `Update` header + `TransactWrite` tasks | AP8/AP9 |
| `GET /v1/checks` | list a site's checks | `Query` **GSI1** `SITE#`, date range, newest-first | AP6 |
| `GET /v1/checks/{checkId}` | one check (header+artifacts+analyses); poll target | `Query` base `SITE#`, `begins_with(sk,"CHECK#<id>")` | AP7 |
| `GET /v1/checks/{checkId}/artifacts/{artifactId}:media` | **presigned GET** for admin review | S3 `getSignedUrl` (GET, short-lived) | — |

**Item writes** (shapes from [data model](./dynamodb-data-model.md) § Item types):

- **Check header** `SITE#<siteId>` / `CHECK#<checkId>` — `status`, `startedAt`, `sides`,
  `issueCount`, `maxSeverity`; carries the **GSI1** key (`startedAt` ISO) for the timeline.
- **Artifact** `SITE#<siteId>` / `CHECK#<checkId>#ART#<side>#<artifactId>` — `capturedAt`, `side`,
  text (if any), the **S3 key** (media in GNP's bucket, ~7-day lifecycle — never the bytes), plus
  `content_type`, size/hash for audit.
- **Analysis** `SITE#<siteId>` / `CHECK#<checkId>#ANALYSIS#<artifactId>` — adapted
  `ratings_details[]`, `rubricVersion`, `analysis_id`, `model`.
- **Tasks** `SITE#<siteId>` / `TASK#<taskId>` — created at **complete**, classified
  `onsite | city_escalation` by **app logic in this repo** (stamped `type`, point-in-time, never
  re-classified), carrying the **GSI2** worklist key (`SITE#<id>#TASK#<status>` / `<severity>#<createdAt>`).
  *GSI3 / city-queue view is post-MVP; the `type` stamp lands now.*

**Task classification** is a small pure module (`classify-task`): map a synthesized finding
(category + severity + hazard) → `onsite` or `city_escalation`. The escalation set is **data,
versioned in-repo, keyed by rubric version** — *not* baked category IDs, because the rubric is
changing. Rather than enumerate today's categories, prefer a rule that keys off the finding's
**`hazard` flag + severity threshold** (rubric-stable signals) plus a small per-rubric-version
allow/deny list for any category that needs special routing. When the rubric bumps, update that
one data file for the new version; closed tasks keep their point-in-time `type`. Unit-tested
against contract fixtures for the pinned version(s).

---

## Analyzer-consumer auth provisioning (Secrets Manager)

1. **Terraform** (`infra/modules/app`): an `aws_secretsmanager_secret`
   (`gnp-<env>-analyzer-api-key`, SSE with the existing app KMS key, CCSF tags). The **value is
   set out-of-band** (not in TF state) once Beaudry issues GNP's consumer key — TF manages the
   secret *container*, not the secret material.
2. **Lambda role:** `secretsmanager:GetSecretValue` on that ARN only + `kms:Decrypt` on the app
   key — least privilege.
3. **Analyze handler:** fetch the key on cold start, **cache in module scope** for the container
   lifetime (avoid a Secrets Manager call per request); refresh on `401` from the analyzer (key
   rotated). Never log the key.
4. **Send as `x-api-key`** on `POST /v1/analyses`, TLS-only. `caller.request_id =
   <checkId>#<artifactId>`.

**Config changes** ([config.js](../backend/src/config.js)): the current `getConfig()` carries
`bedrockModelId` (**now dead** — GNP no longer calls Bedrock directly; the analyzer owns it) and
`uploadBucket` (**revived** — this is now GNP's media bucket for presigned PUT/GET + the worker's
GET). Add: `analyzerBaseUrl` (`ANALYZER_BASE_URL`), `analyzerApiKeySecretArn`
(`ANALYZER_API_KEY_SECRET_ARN`), `analyzerRubricId` (default `street-conditions`),
`analyzerRubricVersion` (default `1.0.0`). Keep `dynamoTable`, `queueUrl`, `uploadBucket`
(`S3_UPLOAD_BUCKET`); drop `bedrockModelId`. Update `AppConfig` JSDoc + `config.test.js`.

---

## Validation & hardening (do these in the demo — cheap, security-review § cross-cutting)

- **Scope the presigned PUT + validate the media in the worker:** the presign step constrains
  `content_type` + size + key prefix; the worker then does a magic-byte / content-type sniff (really
  an image/audio?), **size cap**, and **per-check artifact-count cap** before the analyzer call.
- **Media bucket hardening:** block-public-access, SSE-KMS (app key), TLS-only,
  worker/Lambda-role-only access, and the **~7-day lifecycle** rule (incl. noncurrent versions +
  delete markers). Presigned URLs are the only client access — short-lived, scoped.
- **No media-body logging** — the base64 image must not land in API GW exec/access logs, Lambda/worker
  logs, or (analyzer-account) Bedrock invocation logs. Scrub any structured log of the `input` field;
  enqueue the **S3 key**, never the bytes.
- **`siteId` server-derived**, never from the body — even in the demo wherever a principal exists.
- **Artifacts attach only to a check the same principal created** — conditional write.
- **`store_input:false` + `return_signed_urls:false`** on every analyzer call — GNP holds the only
  copy of the media.
- **Retry `429`/`502`** with exponential backoff + jitter, bounded; on exhaustion, mark the
  `ANALYSIS#` job failed (retriable) rather than losing it — the async worker can redrive.

---

## Build order

- **A. Contract + adapter, pure & offline** — vendor the analyzer request/response **types** from
  the contract; write the `adapt-scorecard` module (service → per-artifact projection, iterating
  whatever categories the response carries) and the `synthesize-check` module (max-rating /
  OR-hazard across artifacts). **Dependency-free unit tests** off the contract fixtures. *No AWS,
  no live analyzer.* **Expect to re-sync** the vendored types + fixtures when Beaudry's rubric
  change lands; because the adapter is category-agnostic, a rubric bump should be a fixture refresh,
  not a rewrite — if it forces handler changes, the adapter wasn't rubric-driven enough.
- **B. Analyzer client** — a thin `analyzer-client` (base URL + `x-api-key` from Secrets Manager,
  `storage:false`, retry/backoff, error mapping). Behind an interface so tests inject a **stub**
  (mirrors the analyzer's own fake-model-client testing approach). Runs green before the service
  deploys.
- **C. Handlers + worker** — create-check, **presign-upload** (S3 `getSignedUrl` PUT, scoped),
  **register-artifact** (`Put` `ART#` with the S3 key + `SendMessage` of the key), the **analyze
  worker** (GET from S3 → downscale with `sharp` → base64 → B → `Put` `ANALYSIS#` + update header
  counters), complete-check (synthesize + tasks), list, get, and **presign-GET** for admin review.
  Conditional writes for idempotency/ownership; the worker is idempotent on `checkId#artifactId`.
  Unit-tested with a mocked Document Client + mocked S3/analyzer (as `process-submission.test.js`
  does today).
- **D. Local harness wiring** — add the routes to the in-process `local-api` router, a **local S3**
  (MinIO — previously deferred) for presigned PUT/GET + the worker's GET, and a stub analyzer
  endpoint, so `curl → create → presign → PUT to S3 → register → worker analyzes (stub) → complete →
  get` runs end-to-end against **DynamoDB Local + MinIO + ElasticMQ**, no cloud, no real key. Extends
  the existing Docker-free harness (which stubbed S3 out until now).
- **E. Terraform** — Secrets Manager secret + IAM read grant + Lambda env vars; **the media S3
  bucket** (block-public-access, SSE-KMS, TLS-only bucket policy, **~7-day lifecycle** incl.
  noncurrent versions + delete markers, CCSF tags) + worker/Lambda IAM for `s3:GetObject` /
  `s3:PutObject` scoped to it; the SQS queue (exists); API Gateway routes. checkov clean. *Applied in
  CI, never locally.*
- **F. Live E2E** — **gated on the analyzer being deployed + GNP issued a key.** Set the secret
  value, point `ANALYZER_BASE_URL` at the real host, run the real perimeter-check flow in the dev
  account. This is the only step that waits on Beaudry.

**A–D can all land now** behind the stub — so when the analyzer ships, only E's secret value and
F remain.

## Local-testability

A–D are fully local (DynamoDB Local + MinIO + ElasticMQ + stub analyzer). E is cloud-only (Secrets
Manager, API GW). F needs the deployed service. The analyzer stub returns a contract-valid response
so the adapter, synthesis, and persistence are exercised without Bedrock or a key.

## Done when

1. Create → presign → PUT to (local) S3 → register → worker analyzes (stub) → complete → get runs
   end-to-end on the **local harness**, writing real `SITE#/CHECK#` header + `ART#` (with S3 key) +
   `ANALYSIS#` + `TASK#` items (A–D). 🎯 *the seam works offline*
2. Adapter + synthesis are unit-tested against the pinned contract fixtures; `rubricVersion` is
   stamped and no `total_score` is persisted.
3. Idempotency + ownership enforced by conditional writes (replay/graft negative tests pass); the
   worker is idempotent on `checkId#artifactId` (redelivered SQS message can't double-write).
4. Uploaded-media validation (magic-byte + size + count), scoped presigned URLs, and no-media-body
   logging verified.
5. Terraform (secret + IAM + **media bucket + lifecycle** + routes) plans/applies clean in CI;
   checkov clean (E).
6. **Live analyze against the deployed service returns a scorecard we persist** (F) — the only
   analyzer-gated criterion.

## Open questions

1. **Sync-vs-async** — ~~open~~ **decided 2026-08-13 PM: async via the SQS worker reading from GNP's
   own S3 bucket** (see the Architecture section). The worker is back on the MVP path; no longer open.
2. **Task classification rules** — the `onsite | city_escalation` mapping keys off `hazard` +
   severity (rubric-stable) plus a per-version category list. Confirm the exact escalation set
   **against the then-current rubric** (it's changing — Beaudry) with the product owner, once the
   rubric stabilizes.
3. **Audio** — the rubric contract exposes `image` and `text` inputs only; there is a
   `street-conditions-transcript-v1` rubric. Confirm whether MVP analyzes audio (via transcript →
   text input) or defers audio analysis to the transcription workstream (post-MVP). Assume
   **defer** unless told otherwise.
4. **Consumed analyzer URL** — confirm the GNP-facing hostname/stage at key-issue time (contract
   says `analysis.streetconditions.org`).
