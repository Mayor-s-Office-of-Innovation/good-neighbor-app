# MVP TODO — path to a deployed Good Neighbor App

**Status:** living tracker · **Date:** 2026-08-12 · **Owner:** team

The single task list on the way to MVP. Plan-level items, not file-level edits — each links to
the plan that backs it. For the read order behind any thread, see [docs/README.md](./README.md).

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · 🎯 milestone · 🔒 blocking decision · ⏭ post-MVP

---

## MVP definition (the done-line)

A security-team member at a site runs a **perimeter check** in the field app; photos/audio/text
go to the **analysis backend**, which returns a scorecard we persist (no raw media at rest); the
check is stored in **DynamoDB**, readable per-site and rolled up into a **city-wide Athena
prototype** with live Tier-1 counters; everything is deployed to a **cloud dev account via
Terraform in CI**, with the **frontend on S3/CloudFront** and **tenant isolation** enforced before
any real multi-site data. Offline/Workbox, transcription, and a full reporting API/dashboard are
explicitly **not** in this line (see [Post-MVP](#post-mvp--parallel-tracks)).

> **What the MVP is not.** Even when this done-line is met, the MVP is **not a shippable product
> anyone could actually use** — it is a **test-users-only** milestone. It runs the
> **deterrence-grade demo auth posture** (real per-device isolation — Option 3 — and retention
> are deliberately deferred), and **all data is temporary and disposable** (wiped wholesale
> between test cycles). "Real" security and durable data are explicitly gated to later phases —
> see the [security review](./security-review.md) and [Post-MVP](#post-mvp--parallel-tracks).

---

## Done

- [x] **Step 1 — JS + JSDoc migration** (backend + repo config; `typecheck` gate in CI). — [plan](./js-and-jsdoc-migration-plan.md)
- [x] **Step 2 — adopt `gnp` as `frontend/`** (built & green under lenient `checkJs`; History routing). — [plan](./gnp-frontend-migration-plan.md)
- [x] **Design decisions D1–D3, I2, I3, M1–M3** resolved (auth model, backend contract, data classification, routing, CSP, PWA/dep alignment). — [plan](./gnp-frontend-migration-plan.md)
- [x] **DynamoDB direction decided** (was D4 / "Proposed") — proceed with DynamoDB over Postgres/Prisma. — [decision](./dynamodb-database-decision.md)
- [x] **DynamoDB planning set written** (decision, data model, analytics addendum, local-dev, buildout). — [index](./README.md)

---

## 🔒 Blocking decisions (resolve early — they gate real work below)

- [x] ✅ **Metric formulas** — *settled 2026-08-12.* Cleanliness = unweighted avg severity per check; compliance = compliant-days ÷ total days, day compliant iff ≥ 3 checks (legal 3×/day, no grace). Raw daily counters + shared scoring module, computed at read. — [data model](./dynamodb-data-model.md)
- [x] ⏭ **Retention policy** — *deferred to post-MVP* (see post-MVP track). No deletion/retention windows during testing; test data is disposable.
- [x] ✅ **City escalation scope** — *settled 2026-08-12:* task owner (site vs city) is classified by **app logic in this repo**, stamped `type` on the task at creation (point-in-time, versionable, no re-classify of closed tasks) — so `type` is **in MVP** from Phase 1. The escalation **integrations** and the cross-site queue view (GSI3/AP11) are **post-MVP** (GSI3 is sparse, addable to the live table later — no rebuild). — [data model](./dynamodb-data-model.md)
- [x] ✅ **Analyzer auth fork** — *settled 2026-08-12; **revised 2026-08-13.*** ~~IAM (SigV4)~~ → **API key per consumer.** The premise changed: "ours" means we **own the code + deploy**, but the analyzer is a **standalone shared service** — streetconditions.org and possibly other (non-AWS) consumers will call it too. For a shared service with heterogeneous consumers, **API-key-per-consumer** is the right boundary (per-consumer identity, revocation, throttling/quota, no cross-account IAM coupling). **Invariants that hold:** it is a **backend-to-backend consumer credential** — our Lambda holds GNP's key **server-side** (Secrets Manager, fetched via the Lambda role); the **field device never holds it** (server-mediation stays); keys are **per-consumer** (GNP's is independently revocable); **TLS-only**. Device→Lambda Option 3 (SigV4) is unaffected. (Optional future: the analyzer's API GW *may* offer IAM auth alongside keys for AWS consumers — not built now.) — [D1](./gnp-frontend-migration-plan.md)
- [x] ✅ **Level-3 / photo-handling** — *settled 2026-08-12; **revised 2026-08-13.*** The staging bucket is **dropped** — images post **base64-inline through our Lambda** (Bedrock's 5 MB cap made a bucket low-value), with `store_input:false` + `return_signed_urls:false` on every analyzer call. So **person-images are never at rest** and the "no media at rest → Level 2" property is delivered **directly, not deferred** — this removes the photo half of the retention pass. Residual controls (no request-body logging, analyzer-account Bedrock invocation logging off, posted-image validation, TLS-only) recorded in [security-review.md](./security-review.md). — [D1](./gnp-frontend-migration-plan.md)
- [x] ✅ **Export cadence** — *settled 2026-08-12:* **incremental exports every 6 hours** (EventBridge, Phase 4). Requires PITR (already on). Full export rejected. Cost is volume-based, so cadence is ~free with incremental. — [addendum](./analytics-plane-addendum.md)
- [x] ✅ **API write authorization / dataset-pollution** — *settled 2026-08-12:* the analyzer is Lambda-only (our Lambda holds the consumer API key server-side), but the client→Lambda endpoint is public, so a site's dataset could be polluted. Go with **Option 3 — device authenticated as the site** (STS creds carrying `custom:siteId`, `siteId` server-derived + `dynamodb:LeadingKeys`-enforced; client never asserts its own site). Demo may run **deterrence-grade** (WAF + throttling) + cross-cutting hardening with residual risk accepted (disposable test data); **Option 3 required before real data** (ties to Phase 6). Needs a shared **device-provisioning / STS-vending backend**. Full threat, invariant, options, and hardening checklist in [security-review.md](./security-review.md). — [D1](./gnp-frontend-migration-plan.md)

---

## Plans still to write

The buildout/analytics docs cover the DynamoDB store and the analytics *data plane*, but two
seams have a decided direction and **no build plan yet**:

- [ ] **Write plan: analysis backend Lambdas** (read/write DynamoDB + server-mediated analyze path). The D1/D2 flow — client posts base64 image → our Lambda validates it → calls analyzer per artifact with the server-held API key → adapts + persists the scorecard (no staging, no media at rest) — is *decided* but has no phased build doc. Covers the perimeter-check endpoints (create/complete/list/get) and the DynamoDB read/write handlers. **Must also cover analyzer-consumer auth provisioning** (revised 2026-08-13): store GNP's analyzer **API key in Secrets Manager** (Terraform), grant the Lambda role read on that secret, fetch-and-cache the key in the analyze handler, pass it on the analyzer call (header per the service's contract — confirm with `../street-conditions-analysis`), TLS-only. — grounded in [D1/D2](./gnp-frontend-migration-plan.md), builds on [data model](./dynamodb-data-model.md)
- [ ] **Write plan: citywide API reporting layer** (app/leadership-facing). The [analytics addendum](./analytics-plane-addendum.md) defines the *data plane* (Tier-1 counters + Athena); it does **not** define the API that serves city reports to a client. Plan the read endpoints over Tier-1 counter items (+ optional Athena passthrough). *Full API is ⏭ post-MVP; MVP needs the plan + KPI reads only.*
- [ ] **Write plan: frontend build + publish (I1)** — build → S3 sync → CloudFront invalidation via OIDC; provision frontend bucket + distribution in Terraform. Direction locked, no plan. — [I1](./gnp-frontend-migration-plan.md)

---

## MVP critical path — DynamoDB buildout

From [dynamodb-buildout-plan.md](./dynamodb-buildout-plan.md). Local-dev harness ([plan](./local-dev-environment-plan.md)) supports Phases 2–3/5.

- [~] **Phase 1 — DynamoDB table (Terraform):** `aws_dynamodb_table` (pk/sk, on-demand, SSE-KMS), GSI1 (checks timeline) + GSI2 (site worklist), PITR + Streams on, TTL wired-but-inactive, CCSF tags — written in [infra/modules/app](../infra/modules/app/main.tf) + outputs (`dynamodb_table_name`, `dynamodb_table_stream_arn`); checkov policy check clean. **Remaining:** CI `terraform plan/apply` to the dev account (no local TF/Docker to prove it here).
- [~] **Phase 2 — app cutover Prisma → DynamoDB SDK:** `db.js` now exports a `@aws-sdk/lib-dynamodb` Document Client; the worker's `upsert` is a conditional `PutCommand` (`attribute_not_exists(pk)`) + `UpdateCommand` replay branch; `dynamoTable` added to `getConfig()` (`DYNAMO_TABLE`); Prisma fully removed (dep, `prisma/`, `DATABASE_URL`, scripts); all gates green (lint/typecheck/test/format/build). **As-built / deferred:** the worker writes an interim idempotency **receipt** item (`SUBMISSION#<requestId>` / `#RECEIPT`), *not yet* the real `SITE#`/`CHECK#` check item — that shape lands with the **analysis-backend Lambdas** (below). Worker is covered by a **dependency-free unit test** (mocked client); the end-to-end `curl → SQS → worker → DynamoDB Local` proof is deferred to the **local harness** task (below). See [buildout plan Phase 2](./dynamodb-buildout-plan.md) for the as-built note.
- [ ] **External dependency — stand up the analyzer service** (ours, from streetconditions.org; separate repo, checked out at `../street-conditions-analysis`, not yet deployed standalone). Built on **API-key auth per consumer**. The analyze path can't run end-to-end until it's deployed on AWS and GNP has been **issued a consumer API key** (stored in Secrets Manager). — [D1](./gnp-frontend-migration-plan.md)
- [ ] **Implement the analysis backend Lambdas** (per the plan written above): server-mediated analyze (posted base64 image → validate → per-artifact call with the API key from Secrets Manager → adapt scorecard), perimeter-check CRUD/list endpoints, DynamoDB read/write.
- [x] **Stand up the Docker-free local harness** (in-process router, ElasticMQ, DynamoDB Local, bootstrap/worker/GUI scripts, one-command `npm run dev`). **Built + verified E2E (2026-08-13):** `backend/scripts/` — `local-ddb`/`local-mq` (JVM jars), `lib/ensure-infra` (idempotent table+queue create, shape mirrors Terraform), `local-api` (in-process router → real handlers, stub `sub`), `local-worker` (long-poll pump → real worker), `db:gui` (dynamodb-admin); `.env.example` + `--env-file`; `npm run dev -w backend`. **Live E2E proven** against JRE 17+ (Temurin 25 LTS): `curl → SQS → worker → DynamoDB Local` writes `SUBMISSION#t1 / #RECEIPT` (`status=received`, stub `sub` threaded through), a re-POST with the same idempotency-key flips it to `duplicate_replay` (conditional-Put replay branch), `GET /health`→200, unknown route→404, clean SIGINT teardown. (S3/MinIO still deferred; handlers don't touch S3 yet.) — [local-dev plan](./local-dev-environment-plan.md)
- [ ] **Phase 3 — seed representative data** (multiple sites, dated checks, varied severities) so reports are meaningful.
- [ ] 🎯 **Phase 4 — T2a analytics pipe (prototype milestone):** analytics S3 bucket + scheduled DynamoDB→S3 export + Glue table + Athena workgroup; the 3 city queries return results in Athena. *End-to-end system felt here.*
- [ ] **Phase 5 — Tier-1 live aggregates:** Streams-driven aggregator Lambda maintaining `STATS#<period>/SITE#<id>` counters (idempotent); wire app KPI reads to a single Query.
- [ ] **Implement citywide reporting KPI reads** (the MVP slice of the reporting-API plan): serve best/worst + compliance from counter items without scans.

---

## MVP critical path — deploy & harden

- [ ] **Implement frontend build + publish (I1):** build → S3/CloudFront via OIDC; provision bucket + distribution + TLS/HSTS/CSP/WAF + CCSF tags in Terraform.
- [ ] **Phase 6 — IAM tenant isolation** (before any real multi-site data / go-live): Cognito `custom:siteId`, device principal, `dynamodb:LeadingKeys` scoping, city-reviewer role scoped to GSI read; verified by a negative test. This is the real-data half of the **Option 3 (device-as-site)** auth decision and needs the **shared device-provisioning / STS-vending backend** (also required by transcription). — [security-review.md](./security-review.md)
- [ ] **Phase 10 — cloud dev env validates wiring:** CI plans/applies real Terraform to a dev account; smoke test hits the real API Gateway endpoint. — [local-dev plan](./local-dev-environment-plan.md)
- [ ] **Harden the analyze write endpoint** (cheap controls, do in the demo — per the API-auth + photo-handling decisions): server-derive `siteId` (never from the body), validate the posted image (magic-byte + size + count caps — replaces the dropped presigned-PUT constraints), no request-body logging (base64 image kept out of API GW / Lambda logs), conditional artifact→check writes, per-site rate limits (WAF + API GW usage plans). — [security-review.md](./security-review.md)
- [ ] 🔒 **Shrink the SF city-seal asset to a PNG** (blocks go-live weight/Core Web Vitals): the Wikimedia seal SVG is **2.3MB** (only ~1.1MB after `svgo`) but renders at **44px** in the today-view header. Replace with a ~132px (3×) optimized PNG (~5–15KB) — or a hand-simplified SVG — before ship. Don't inline the raw SVG.
- [ ] **Security review recorded** ([security-review.md](./security-review.md)) + run checkov/SAST on new Terraform and the new Lambdas.
- [ ] **Go-live gates** ([README](../README.md#required-reviews-before-go-live)): Mozilla Observatory A+, SSL Labs A+, Core Web Vitals, WCAG 2.2 AA + keyboard pass, CCSF tag verification, pin GitHub Actions to commit SHAs.
- [ ] **Docs cutover:** drop Prisma/Postgres standing choices from [AGENTS.md](../AGENTS.md); supersede [ADR 0001](./adr/0001-architecture-stack.md); scrub Prisma refs in migration plans.

---

## Post-MVP / parallel tracks

- [ ] ⏭ **Offline / Workbox pass:** service worker + background-sync POST queue (`offline-submissions`, 24h). Deferred product decision. — [M2](./gnp-frontend-migration-plan.md)
- [ ] ⏭ **Frontend Step 3 — continue features** from `gnp`'s design docs. — [plan](./gnp-frontend-migration-plan.md)
- [ ] ⏭ **Live transcription workstream** — test the built spike, then device-token backend (invite codes + STS cred vending), client site-setup + streaming component, wire into form. — [STATUS](./transcription-STATUS.md) · [architecture](./transcription-architecture.md)
- [ ] ⏭ **Full citywide reporting API + dashboard** — the complete API layer + QuickSight or app-rendered charts on the analytics plane (MVP stops at the Athena prototype + KPI reads).
- [ ] ⏭ **Retention & data-deletion pass** (after initial testing exits): now **photos are out of scope** — there is no staging bucket and images are never at rest (revised 2026-08-13), so only **DynamoDB TTL activation** and **S3-export (analytics) lifecycle** remain. Deliberately deferred. — [D1](./gnp-frontend-migration-plan.md)
- [ ] ⏭ **Escalation integrations + city queue view** — dispatch/routing of `city_escalation` tasks to city teams (and any external systems), plus Phase 7 **GSI3** cross-site queue (AP11). Task-type classification already lands in MVP; this is the downstream routing + citywide view.
- [ ] ⏭ **Tier-2b streaming analytics** (Streams → Firehose → Parquet) — only if near-real-time dashboards ever become a requirement.
