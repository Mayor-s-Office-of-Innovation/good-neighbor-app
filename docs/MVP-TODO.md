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
- [x] ✅ **Analyzer auth fork** — *settled 2026-08-12:* analyzer is **ours on AWS**, so the Lambda authenticates via **IAM (SigV4)** — no Secrets Manager credential. (It's the streetconditions.org scorecard service; separate repo, not yet deployed standalone — see dependency below.) — [D1](./gnp-frontend-migration-plan.md)
- [x] ✅ **Level-3 / photo-handling (testing phase)** — *settled 2026-08-12:* deferred photo deletion is acceptable **for testing** (disposable data, wiped wholesale between cycles) **provided** the staging bucket is locked down (Block Public Access, SSE-KMS, TLS-only, Lambda-role-only, no object-content logging). Strict retention + re-review required before real (non-test) data. Recorded in [security-review.md](./security-review.md). — [D3](./gnp-frontend-migration-plan.md)
- [x] ✅ **Export cadence** — *settled 2026-08-12:* **incremental exports every 6 hours** (EventBridge, Phase 4). Requires PITR (already on). Full export rejected. Cost is volume-based, so cadence is ~free with incremental. — [addendum](./analytics-plane-addendum.md)
- [x] ✅ **API write authorization / dataset-pollution** — *settled 2026-08-12:* the analyzer is Lambda-only (IAM/SigV4), but the client→Lambda endpoint is public, so a site's dataset could be polluted. Go with **Option 3 — device authenticated as the site** (STS creds carrying `custom:siteId`, `siteId` server-derived + `dynamodb:LeadingKeys`-enforced; client never asserts its own site). Demo may run **deterrence-grade** (WAF + throttling) + cross-cutting hardening with residual risk accepted (disposable test data); **Option 3 required before real data** (ties to Phase 6). Needs a shared **device-provisioning / STS-vending backend**. Full threat, invariant, options, and hardening checklist in [security-review.md](./security-review.md). — [D1](./gnp-frontend-migration-plan.md)

---

## Plans still to write

The buildout/analytics docs cover the DynamoDB store and the analytics *data plane*, but two
seams have a decided direction and **no build plan yet**:

- [ ] **Write plan: analysis backend Lambdas** (read/write DynamoDB + server-mediated analyze path). The D1/D2 flow — presigned S3 upload → Lambda calls analyzer with server-held cred → persist scorecard → delete staged object — is *decided* but has no phased build doc. Covers the perimeter-check endpoints (create/complete/list/get) and the DynamoDB read/write handlers. — grounded in [D1/D2](./gnp-frontend-migration-plan.md), builds on [data model](./dynamodb-data-model.md)
- [ ] **Write plan: citywide API reporting layer** (app/leadership-facing). The [analytics addendum](./analytics-plane-addendum.md) defines the *data plane* (Tier-1 counters + Athena); it does **not** define the API that serves city reports to a client. Plan the read endpoints over Tier-1 counter items (+ optional Athena passthrough). *Full API is ⏭ post-MVP; MVP needs the plan + KPI reads only.*
- [ ] **Write plan: frontend build + publish (I1)** — build → S3 sync → CloudFront invalidation via OIDC; provision frontend bucket + distribution in Terraform. Direction locked, no plan. — [I1](./gnp-frontend-migration-plan.md)

---

## MVP critical path — DynamoDB buildout

From [dynamodb-buildout-plan.md](./dynamodb-buildout-plan.md). Local-dev harness ([plan](./local-dev-environment-plan.md)) supports Phases 2–3/5.

- [ ] **Phase 1 — DynamoDB table (Terraform):** `aws_dynamodb_table` (pk/sk, on-demand, SSE-KMS), GSI1 (checks timeline) + GSI2 (site worklist), PITR + Streams on, TTL wired, CCSF tags. Applied in CI.
- [ ] **Phase 2 — app cutover Prisma → DynamoDB SDK:** replace `db.js` with `@aws-sdk/lib-dynamodb`; rewrite worker upsert as conditional `Put`/`Update`; remove Prisma entirely; keep `typecheck` green. Local-testable on DynamoDB Local.
- [ ] **External dependency — stand up the analyzer service** (ours, from streetconditions.org; separate repo, not yet checked out or deployed standalone). The analyze path can't run end-to-end until it's deployed on AWS with an IAM-authorized invoke path for our Lambda's role. — [D1](./gnp-frontend-migration-plan.md)
- [ ] **Implement the analysis backend Lambdas** (per the plan written above): presigned upload, server-mediated analyze (IAM/SigV4 to our analyzer) + delete, perimeter-check CRUD/list endpoints, DynamoDB read/write.
- [ ] **Stand up the Docker-free local harness** (in-process router, ElasticMQ, DynamoDB Local, bootstrap/worker/GUI scripts, one-command `npm run dev`). — [local-dev plan](./local-dev-environment-plan.md)
- [ ] **Phase 3 — seed representative data** (multiple sites, dated checks, varied severities) so reports are meaningful.
- [ ] 🎯 **Phase 4 — T2a analytics pipe (prototype milestone):** analytics S3 bucket + scheduled DynamoDB→S3 export + Glue table + Athena workgroup; the 3 city queries return results in Athena. *End-to-end system felt here.*
- [ ] **Phase 5 — Tier-1 live aggregates:** Streams-driven aggregator Lambda maintaining `STATS#<period>/SITE#<id>` counters (idempotent); wire app KPI reads to a single Query.
- [ ] **Implement citywide reporting KPI reads** (the MVP slice of the reporting-API plan): serve best/worst + compliance from counter items without scans.

---

## MVP critical path — deploy & harden

- [ ] **Implement frontend build + publish (I1):** build → S3/CloudFront via OIDC; provision bucket + distribution + TLS/HSTS/CSP/WAF + CCSF tags in Terraform.
- [ ] **Phase 6 — IAM tenant isolation** (before any real multi-site data / go-live): Cognito `custom:siteId`, device principal, `dynamodb:LeadingKeys` scoping, city-reviewer role scoped to GSI read; verified by a negative test. This is the real-data half of the **Option 3 (device-as-site)** auth decision and needs the **shared device-provisioning / STS-vending backend** (also required by transcription). — [security-review.md](./security-review.md)
- [ ] **Phase 10 — cloud dev env validates wiring:** CI plans/applies real Terraform to a dev account; smoke test hits the real API Gateway endpoint. — [local-dev plan](./local-dev-environment-plan.md)
- [ ] **Harden the photo staging bucket** (required during testing, per the D3 testing-phase decision): Block Public Access, SSE-KMS, TLS-only, Lambda-role-only access, no object-content logging. Verify with checkov. — [security-review.md](./security-review.md)
- [ ] **Harden the analyze write endpoint** (cheap controls, do in the demo — per the API-auth decision): server-derive `siteId` (never from the body), constrain the presigned PUT (content-length-range/content-type/single-key/short-expiry), validate the staged object (magic-byte + size + count caps), conditional artifact→check writes, per-site rate limits (WAF + API GW usage plans). — [security-review.md](./security-review.md)
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
- [ ] ⏭ **Retention & data-deletion pass** (after initial testing exits): implement photo-after-analysis deletion (D1/D3 — Lambda delete + S3 lifecycle incl. noncurrent versions & delete markers), DynamoDB TTL activation, and S3-export lifecycle. Deliberately deferred; **baseline staging-bucket controls (block-public-access, SSE-KMS, TLS-only, Lambda-role-only) still apply during testing** even though expiry is deferred. — [D1/D3](./gnp-frontend-migration-plan.md)
- [ ] ⏭ **Escalation integrations + city queue view** — dispatch/routing of `city_escalation` tasks to city teams (and any external systems), plus Phase 7 **GSI3** cross-site queue (AP11). Task-type classification already lands in MVP; this is the downstream routing + citywide view.
- [ ] ⏭ **Tier-2b streaming analytics** (Streams → Firehose → Parquet) — only if near-real-time dashboards ever become a requirement.
