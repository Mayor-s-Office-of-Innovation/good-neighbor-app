# Review: docs/dev-architecture.md

Fact-check of [dev-architecture.md](./dev-architecture.md) (the other agent's doc) against the
codebase on 2026-08-28. Verified against: `frontend/vite.config.js`, `frontend/src/services/*.js`,
`backend/scripts/*` + `backend/scripts/lib/*`, `backend/src/lambda/*`, `backend/src/handlers/*`,
`backend/src/workers/*`, `backend/src/analysis/*`, `backend/src/lib/principal.js`,
`infra/modules/app/*`, `.env.example`, and the two backend/package.json files.

**Verdict:** accurate on architecture — topology, ports, resource names, env-var mechanism,
route parity, and the big invariants all check out. Five small factual nits and two missing
routes in the section that claims completeness. Fixes below are small; the doc is otherwise
trustworthy.

---

## What checks out

- **Ports, names, processes** — Vite `:5173` proxying `/v1` · `/site-code` · `/health` → `:3001`
  (`frontend/vite.config.js:35`); `local-api.mjs :3001`; worker long-poll (20 s, batch 10);
  DynamoDB Local `:8000`; ElasticMQ `:9324`; MinIO `:9000` (console `:9001`); `dynamodb-admin`
  `:8001` via `npm run db:gui`. Names match `.env.example`: table `gnp-local-app`, queue
  `gnp-local-submissions`, bucket `gnp-local-uploads`.
- **Three-way route parity** — all 17 routes in `backend/scripts/local-api.mjs:80-114` ==
  `backend/src/lambda/api.js:36-60` == `infra/modules/app/api.tf:8-26`. The "keep all three in
  step" claim holds today.
- **One CloudFront distro / `BASE=""`** — matches `services/api.js:19-26` and
  `services/onboarding.js:7-13`.
- **Presign → direct PUT → register**, queue carries the S3 key (never bytes), client-minted
  `checkId` as `idempotency-key`, conditional/idempotent writes, worker concurrent fan-out with
  delete-only-on-success, `waitForAnalyses` throwing on timeout, `completeCheck`'s coverage gate
  (409 analyzing) — all verified in `handlers/artifacts.js`, `handlers/checks.js`,
  `workers/analyze-artifact.js`, `services/api.js`, `services/submit-check.js`.
- **Real analyzer in dev** — `.env.example:55-61`; `x-api-key` server-side + `store_input:false`
  match `analysis/analyzer-client.js:110-119,191`.

## Inaccuracies

1. **Seeded site codes rendered with hyphens** (diagram, line 36: "seeds site codes 123-456 /
   000-000"). Actual values are `123456` and `000000` (`backend/scripts/lib/ensure-infra.mjs:236,247`).
   Worth adding: `000000` is seeded **inactive** to exercise the invalid-code (401) path.

2. **createCheck returns 201, not 200** (sequence, line 179: `200 { checkId, status }`).
   Fresh create returns **201** (`handlers/checks.js:107`); 200 only on idempotent replay
   (`handlers/checks.js:114`).

3. **siteId derivation overstated** (lines 80, 149-150). `deriveSiteId` reads only the
   `custom:siteId` claim and falls back to `DEMO_SITE_ID` (`backend/src/lib/principal.js:17-21`).
   The local stub injects just `sub` (`scripts/lib/proxy-event.mjs:76-80`), so **X-Debug-Sub has
   no effect on the tenant partition** — locally everything lands in `SITE#demo-site`. The prod
   mapping row ("Cognito JWT authorizer (`sub`)") is also aspirational: the MVP API Gateway has
   **no authorizer** (`infra/modules/app/api.tf:45`), so prod similarly resolves to `DEMO_SITE_ID`.

4. **"write assessment" on complete** (sequence, line 211). `completeCheck` persists only the
   folded scorecard fields onto the CHECK header via a conditional TransactWrite
   (`handlers/checks.js:210-241`); the assessment envelope is built and **returned** in the
   response, not written as its own item.

5. **Queue message body simplified** (sequence, line 189). Actual body is
   `{ siteId, checkId, artifactId, side, capturedAt, s3Key?, text? }`
   (`handlers/artifacts.js:195-208`); text-only artifacts enqueue `text` with no key. The
   "(s3Key, not bytes)" invariant still holds for photos; the enumeration is just incomplete.

## Coverage gaps (§2 claims "every route the SPA hits")

6. **Two of the 17 routes are missing** from the §2 routing map:
   - `POST /v1/checks/{checkId}/sides/{side}/description:validate` →
     `handlers/description-validation.js` (frontend: `api.validateSideDescription`,
     `services/api.js:211`)
   - `POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers` →
     `guidance.js` `submitConditionAnswers` (called from
     `frontend/src/components/guidance-harness.js:388`)

   Relatedly, the `hGuid` node (line 112) lists only 4 of `guidance.js`'s 5 exports
   (`submitConditionAnswers` omitted).

7. **The Bedrock table row (line 82, "mocked locally") undersells the local behavior.** The
   description-validation route is **live locally** via the keyword heuristic
   (`BEDROCK_ALLOW_LOCAL_STUB=true` + `BEDROCK_MODEL_ID=local-stub-model` →
   `heuristicValidate`, `analysis/description-validator.js:100-107,211-221`), with
   `DESCRIPTION_VALIDATION_DISABLED=true` as an escape hatch (`.env.example:25-28`).

## Disagreements with `dev-architecture2.md`

- **Description validation locally:** dev-architecture.md is effectively correct (heuristic
  stub, working locally); dev-architecture2.md's claim ("handler reports missing Bedrock
  configuration") is wrong with the documented default `.env.local` — fix there, not here.
- Where the two docs overlap elsewhere, dev-architecture.md matches the code on every point;
  dev-architecture2.md adds infra detail these findings didn't contradict (Lambda sizing, event
  source mapping concurrency, DLQ, GSI inventory).