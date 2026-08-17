# Plan: Analysis-Backend Lambdas (perimeter-check API + server-mediated analyze)

*Build plan · [index](./README.md) · grounded in [D1/D2](./gnp-frontend-migration-plan.md) ·
builds on [data model](./dynamodb-data-model.md) · reconciles with
[buildout Phase 2](./dynamodb-buildout-plan.md)*

**Status:** In build — Steps A–D + C shipped & green; the **live analyze path is proven end-to-end via the local harness (2026-08-16)** against the deployed analyzer (presign → worker → `x-api-key` call → `ANALYSIS#`/`TASK#`). **Remaining:** Step E (Terraform packaging + Secrets Manager key retrieval + real `sharp` resize) and the prod-only bits (real per-photo GPS). · **Date:** 2026-08-13 (contract re-pinned 2026-08-14; status updated 2026-08-16) · **Owner:** team

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

Re-pinned from `../street-conditions-analysis/contract/` (openapi.yaml + JSON schemas) and
`rubrics/good-neighbor-app-v1.json` as of **2026-08-14** (Beaudry's GNA-rubric PR merged).
**The service owns the rubric and data format; we adapt to it, never the reverse.**

- **Endpoint:** `POST /v1/analyses` · **Auth:** `x-api-key` header · **TLS-only** ·
  host will be `https://analysis.streetconditions.org` (confirm the GNP-consumed URL at issue-time).
- **Request** (`analysis-request.schema.json`): `{ rubric_id, rubric_version?, metadata, media, storage?, caller? }`.
  - **`metadata` is now REQUIRED**: `{ reported_at, latitude, longitude, position_descriptor, notes? }`.
    New — the analyze call needs **GPS + a position descriptor** (position ↔ perimeter side).
    → capture-flow requirement (see open questions).
  - **`media` is an array** (was `input`) whose items are `oneOf`:
    - image: `{ type:"image", content_type:"image/jpeg|png|webp", base64 }`
    - text:  `{ type:"text", text }` (min length 5)
    - Because `metadata` is singular per request, one call naturally carries **all media for one
      position/side** (see the per-side-vs-per-artifact open question).
  - **We always send `storage:{ store_input:false, return_signed_urls:false }`** so the analyzer
    keeps no copy. `caller.request_id` = our `checkId#artifactId` (or `checkId#side`) for
    traceability; `caller.app_id` is **not trusted for authz** (the API key is the identity).
- **Rubric:** `rubric_id="good-neighbor-app"`, `rubric_version="1.0.0"` — **13 categories**, each
  with a **`weighting`** (Low/Moderate/High), `severity` **0–5**. The rubric is **CSV-generated**
  (`scripts/convert-csv-rubrics.mjs`), so category *wording* may churn — build off **ids +
  weightings** (the stable surface), never descriptions. `GET /v1/rubrics` +
  `GET /v1/rubrics/{id}/versions/{version}` expose the live category set/weightings for runtime
  discovery. Weightings (this pin): **High** — feces_and_urine, needles, temporary_shelters,
  fire_hazard, behavioral_health, medical_emergency; **Moderate** — blocking_access,
  public_drug_use, dangerous_animals, intimidation_and_violence; **Low** — litter, large_waste,
  graffiti.
- **Response** (`analysis-response.schema.json`): `{ analysis_id, rubric:{id,version}, created_at,
  model:{provider,model_id}, caller?, input_storage, assessment, result_storage? }`. The
  **`assessment`** is `{ metadata:{position_descriptor,…}, general_conditions:{ label, description },
  identified_conditions_of_concern:[…] }`:
  - **`general_conditions.label`** ∈ Excellent | Good | Fair | Poor | Very Poor — the **overall
    grade, computed server-side** from all category severities × weightings via the rubric's
    `generalConditions` rules. **We adopt this as the check grade** (no total_score computed by us).
  - **`identified_conditions_of_concern[]`** is an **exceptions list** (only categories of concern,
    not a full per-category scorecard). Each: `{ category (free-text label), definition,
    severity(0–5), severity_label?, description, evidence_indices, confidence? }`.
  - **`hazard_detected` is gone.** "How serious is this category" now lives in the per-category
    **`weighting`**, which the service applies **server-side** when computing
    `general_conditions.label` — it is **not** returned on each concern, and we don't re-derive it
    (see the "No vendored rubric" note below).
- **Error codes we must handle:** `400` invalid request, `401` bad/missing key, `403` rubric not
  allowed, `413` `input_too_large` (downscale further), `422` invalid model response, `429`
  `model_throttled` (**retry w/ exponential backoff**), `502` model invocation failed.

### The adapter (service assessment → our persisted shape)

A **caller-side adapter** (`adapt-scorecard`) maps the service `assessment` to our per-artifact
`ANALYSIS` projection. It is a **thin projection** — the service totally owns the rubric, the grade,
and the concerns; we only reshape to our naming, drop fields we don't persist, and precompute two
rollups. Keeping it thin decouples our stored item shape from the wire shape, so a contract tweak
doesn't ripple into DynamoDB items. **Mapping (re-pinned 2026-08-14; simplified 2026-08-14 — see the
"no vendored rubric" note below):**

| service field | our field | note |
|---|---|---|
| `assessment.general_conditions.label` | `grade` | Excellent…Very Poor — **service-computed overall grade, adopted as-is** |
| `assessment.general_conditions.description` | `gradeDescription` | |
| `assessment.identified_conditions_of_concern[].category` | `concerns[].category` | free-text label; no stable id in the response |
| `…of_concern[].severity` | `concerns[].rating` | 0–5, rubric-owned scale |
| `…of_concern[].severity_label` | `concerns[].ratingLabel` | optional |
| `…of_concern[].description` | `concerns[].explanation` | |
| `…of_concern[].evidence_indices` | `concerns[].evidenceIndices` | per-call; check-level attribution is by artifact |
| `rubric.version` | `rubricVersion` | **stamp on every ANALYSIS item** — provenance; never mix scales/versions in a rollup |
| `analysis_id` | `analysisId` | |
| `model` | `model` | `{provider, model_id}` — provenance |
| `…of_concern[].confidence`, `.definition` | — | **dropped** |

The adapter also precomputes `issueCount` (concerns with `rating > 0`) and `maxSeverity` off the
concerns list. The adapted list is **`concerns[]`** (this supersedes the old `ratings_details[]` /
`issues[]` names). We adopt the service `grade` directly and **do not** compute a `total_score` — the
previous "compute a cleanliness average at read" plan is superseded (see
[data model](./dynamodb-data-model.md) § Metric definitions, 2026-08-14 note): the response is an
**exceptions list**, not a per-category scorecard, so not every category carries a severity and an
unweighted average no longer applies.

> **No vendored rubric (decided 2026-08-14).** An earlier draft joined each concern to a
> `rubric-meta` map (a hand-copied subset of the analysis repo's rubric) to attach a `weighting`
> (Low/Moderate/High) — the intended replacement for the removed `hazard_detected`. **Dropped.** The
> service response carries no `weighting`, and it doesn't need to: `general_conditions.label` is
> *already* computed server-side from every category's severity × weighting, so the grade we adopt
> bakes weighting in. The only prospective consumer was the deferred escalation classifier — and
> escalation routing is **GNP business policy** (which categories warrant a city escalation), keyed
> off the category *identity* the service already returns, not a copy of the vendor's rubric weights.
> So we depend cleanly on the service for rubric + grade + concerns, and carry no cross-repo data to
> keep in sync. If the classifier ever genuinely needs the rubric weightings, source them from the
> service (`GET /v1/rubrics/{id}/versions/{version}`, or ask for a `weighting` field on each concern)
> rather than re-vendoring the JSON.

**Check-level synthesis** (`synthesize-check`, for the UI's single scorecard): the service grades
each analyzed position; the check `grade` is the **worst grade across the check's artifacts**
(Excellent < Good < Fair < Poor < Very Poor) — a GNP perimeter rollup. Per category we take the
**max `rating`**, attributing each finding to its **source artifact** (not the model's per-call
`evidence_indices`). This output shape maps directly onto the `CHECK#` header extension (see
[data model](./dynamodb-data-model.md)). Documented fallback if the analyzer usage-plan quota bites:
batch-per-modality (one call for all a check's photos), losing per-photo attribution.

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
  `issueCount`, `maxSeverity`; carries the **GSI1** key (`startedAt` ISO) for the timeline. **At
  `complete` the header also holds the synthesized check-level scorecard** — this header *is* the
  perimeter synthesis (one `CHECK#` = one full run across all sides; no separate synthesis item):
  `grade` (worst across artifacts, on the header so the GSI1 list view has it without a fan-out),
  a per-category rollup `[{ category, maxRating, sourceArtifactIds }]`, `rubricVersion`,
  and `synthesizedAt`. Point-in-time, written once at `complete`.
- **Artifact** `SITE#<siteId>` / `CHECK#<checkId>#ART#<side>#<artifactId>` — `capturedAt`, `side`,
  text (if any), the **S3 key** (media in GNP's bucket, ~7-day lifecycle — never the bytes), plus
  `content_type`, size/hash for audit.
- **Analysis** (per artifact — the raw service output) `SITE#<siteId>` /
  `CHECK#<checkId>#ANALYSIS#<artifactId>` — adapted `concerns[]` (supersedes `ratings_details[]`),
  `grade`, `gradeDescription`, `rubricVersion`, `analysisId`, `model`.
- **Tasks** `SITE#<siteId>` / `TASK#<taskId>` — created at **complete**, classified
  `onsite | city_escalation` by **app logic in this repo** (stamped `type`, point-in-time, never
  re-classified), carrying the **GSI2** worklist key (`SITE#<id>#TASK#<status>` / `<severity>#<createdAt>`).
  *GSI3 / city-queue view is post-MVP; the `type` stamp lands now.*

**Task classification** (`classify-task`) is **deferred to Step C and lives in THIS repo** — Step A
only builds the *seam* (`synthesize-check` exposes exactly the signals the classifier consumes:
per-category `maxRating` keyed off the **category identity** the service returns). When built, it
maps a synthesized finding (category + `rating`) → `onsite` or `city_escalation`. This is **GNP
business policy** — *which* categories warrant a city escalation — not rubric data: the escalation
set is **data, versioned in-repo, keyed by rubric version**, *not* baked category IDs (the rubric
wording churns — CSV-generated). It keys off the category identity plus a `rating` threshold, with a
small per-rubric-version routing table. If a rule ever needs the rubric's own `weighting`, source it
from the service (`GET /v1/rubrics/{id}/versions/{version}`) rather than re-vendoring the JSON — the
grade already bakes weighting in server-side, so we carry no cross-repo rubric copy. When the rubric
bumps, update that one data file for the new version; closed tasks keep their point-in-time `type`.
The **exact escalation mapping over the 13 categories is an open product decision** (see open
questions). Unit-tested against contract fixtures for the pinned version(s).

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
(`ANALYZER_API_KEY_SECRET_ARN`), `analyzerRubricId` (default `good-neighbor-app`),
`analyzerRubricVersion` (default `1.0.0`). *(Re-pinned 2026-08-14: default `analyzerRubricId` is now
`good-neighbor-app`, not `street-conditions`.)* Keep `dynamoTable`, `queueUrl`, `uploadBucket`
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

- **A. Contract + adapter, pure & offline** *(re-pinned 2026-08-14 to GNA rubric v1.0.0)* — under
  `backend/src/analysis/`: `contract.js` (vendored response `@typedef`s + `RUBRIC_ID`/`RUBRIC_VERSION`),
  `adapt-scorecard.js` (`adaptAssessment` → per-artifact `concerns[]` projection, iterating whatever
  concerns the response carries), `synthesize-check.js` (`synthesizeCheck` → worst-grade +
  per-category max-rating across artifacts), and GNA-flavored `fixtures/`. **Dependency-free unit
  tests.** *No AWS, no live analyzer.* The adapter is a **thin, category-agnostic projection** — it
  carries no vendored rubric data (see the "No vendored rubric" note above), so a rubric bump is a
  fixture refresh, not a rewrite — if it forces handler changes, the adapter wasn't thin enough.
  > **As-built (2026-08-14):** the modules (`contract.js`, `adapt-scorecard.js`, `synthesize-check.js`)
  > + three GNA fixtures + dependency-free Vitest specs exist under `backend/src/analysis/`;
  > `npm run test/typecheck/lint -w backend` (and the root `npm test`) are green (20 tests). The
  > adapted per-artifact list is named `concerns[]`. **Simplified 2026-08-14:** an earlier draft also
  > vendored a `rubric-meta.js` weighting map (+ unknown-category flagging); it was dropped — the
  > service owns the rubric/grade and returns no weighting, so we carry no cross-repo copy. B and C
  > are now landed too (see their as-built notes); D–F remain.
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
  > **As-built (2026-08-14):** shipped under `backend/src/` — `handlers/checks.js`
  > (`createCheck`, `completeCheck`, `listChecks`, `getCheck`), `handlers/artifacts.js`
  > (`presignUpload`, `registerArtifact`, `presignMedia`), `workers/analyze-artifact.js`,
  > plus shared `handlers/keys.js`, `lib/principal.js`, `s3.js`, `media/downscale.js`,
  > `analysis/task-routing.js`, `analysis/api-key.js`. All conditional/transactional writes
  > and worker idempotency are covered by mocked-SDK Vitest specs; `lint`/`typecheck`/`test`
  > (79 tests)/`prettier --check` green. **Deferred to E/F as planned:** `downscaleImage` is a
  > passthrough seam (real `sharp` resize is Step E packaging); `getAnalyzerApiKey()` reads
  > `ANALYZER_API_KEY` from env (Secrets Manager fetch is Step E); the escalation matrix in
  > `task-routing.js` is a **placeholder** pending the product team's real mapping. The old
  > `submissions.js`/`process-submission.js` receipt path is left intact (router swap is Step D).
  > See [architecture.md](./architecture.md) for the as-built container + sequence + ER diagrams.
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
2. **Task classification / escalation rules** — **deferred; classifier lives in this repo** (Step C,
   not Step A). The `onsite | city_escalation` mapping keys off **category identity** + a `rating`
   threshold, held in a per-rubric-version routing table (GNP policy, not rubric data). Confirm the
   exact escalation set over the **13 GNA categories** with the product owner — an open product
   decision.
3. **Audio** — the rubric contract exposes `image` and `text` inputs only; there is a
   `street-conditions-transcript-v1` rubric. Confirm whether MVP analyzes audio (via transcript →
   text input) or defers audio analysis to the transcription workstream (post-MVP). Assume
   **defer** unless told otherwise.
4. **Consumed analyzer URL** — confirm the GNP-facing hostname/stage at key-issue time (contract
   says `analysis.streetconditions.org`).
5. **Call grain: per-side vs per-artifact** — the request's `metadata` (with `position_descriptor`)
   is singular per call, so one analyze call naturally carries all media for **one position/side**.
   Current plan enqueues **per-artifact** (`checkId#artifactId`). Confirm whether we call once per
   artifact or once per side (all that side's media in one `media[]`) — affects the worker, the
   `caller.request_id` key, and per-photo attribution. Step A is grain-agnostic (synthesis takes a
   list of `{artifactId, side, assessment}`), so this can be settled in Step C.
6. **GPS + position capture (new contract requirement)** — `metadata` now **requires**
   `latitude`/`longitude`/`reported_at`/`position_descriptor`. The capture flow must collect device
   GPS + map each capture to a perimeter side. New UI/permission work — coordinate with the v1
   design update.
