# Development environment architecture

Dev-focused view of the system: what the frontend calls, which code handles it
(the **same exported Lambda handlers we deploy**), and what each handler talks
to. Design rationale for the harness: [ADR 0006](./adr/0006-docker-free-local-dev-harness.md).
Prod architecture lives in [architecture.md](./architecture.md).

```mermaid
flowchart TB
  classDef edge fill:#f3f9ff,stroke:#2b6cb0,color:#1a365d
  classDef emu fill:#fff8f0,stroke:#b7791f,color:#5f370e
  classDef remote fill:#fff5f5,stroke:#c53030,color:#742a2a
  classDef tool fill:#f7f7f7,stroke:#a0aec0,color:#4a5568,stroke-dasharray:3 3

  browser["Browser (laptop / phone on LAN)<br/>same SPA code that ships to prod"]

  subgraph vite["frontend · npm run dev -w frontend"]
    viteserver["Vite dev server :5173<br/>SPA fallback + History-API router"]
  end

  browser -- same-origin GET/POST --> viteserver

  subgraph harness["backend · npm run dev -w backend (one process tree, Ctrl-C tears down all)"]
    api["In-process API router :3001<br/>scripts/local-api.mjs<br/>STAND-IN FOR: API Gateway HTTP API v2<br/>builds real APIGatewayProxyEventV2 events,<br/>stubs Cognito sub via X-Debug-Sub header"]
    apiroutes["Route dispatch on routeKey<br/>mirrors src/lambda/api.js + Terraform routes"]
    pump["SQS → worker pump<br/>scripts/local-worker.mjs<br/>STAND-IN FOR: Lambda SQS event-source mapping<br/>(polls queue, dispatches per message type)"]
    analyze["analyze-artifact worker<br/>src/workers/analyze-artifact.js<br/>(same code the worker Lambda runs)"]
    submission["process-submission worker<br/>src/workers/process-submission.js"]
  end

  viteserver -- proxy /v1 · /site-code · /health --> api

  subgraph handlers["Real handler layer — backend/src/handlers (identical to deployed bundles)"]
    checks["checks.js<br/>createCheck · getCheck · listChecks · completeCheck"]
    artifacts["artifacts.js<br/>presignUpload · registerArtifact · presignMedia"]
    tasks["tasks.js · guidance.js"]
    others["site-code.js · submissions.js<br/>description-validation.js · health.js"]
  end

  api -- dispatch --> handlers

  subgraph emulators["Local emulators (bootstrapped by ensureLocalInfra)"]
    ddb["DynamoDB Local :8000<br/>PROD EQUIVALENT: single-table gnp-app<br/>pk = SITE#&lt;siteId&gt; + GSIs 1/2/4/5"]
    mq["ElasticMQ :9324<br/>PROD EQUIVALENT: SQS submissions queue<br/>(message body = S3 key + metadata, never bytes)"]
    minio["MinIO :9000<br/>PROD EQUIVALENT: S3 uploads (media) bucket<br/>presigned PUT / GET"]
  end

  bootstrap["ensureLocalInfra()<br/>creates table + queue + bucket on boot"]
  bootstrap -. self-bootstrap .-> emulators

  handlers -- "PutItem / Query / TransactWrite<br/>CHECK# · ART# · ANALYSIS# · TASK#" --> ddb
  artifacts -- presigned PUT url returned to browser --> minio
  artifacts -- "SendMessage {s3Key, artifactId,…}" --> mq
  minio -- "cross-origin PUT (media bytes,<br/>straight to S3 — never through :5173 or :3001)" --> browser

  pump -- message with s3Key / text --> analyze
  pump -- /submissions receipt message --> submission
  submission -- ANALYSIS#/TASK# writes --> ddb
  submission -- status receipt --> ddb
  analyze -- "GetObject(s3Key) → downscale + base64" --> minio
  analyze -- "PutItem ANALYSIS# (idempotent)" --> ddb
  analyze -- "POST /v1/analyses (metadata + media base64,<br/>store_input:false; x-api-key from .env.local)" --> analyzer

  analyzer["External analyzer service<br/>backend/src/analysis/analyzer-client.js<br/>⚠ REAL service in dev too — set ANALYZER_BASE_URL<br/>+ ANALYZER_API_KEY or this leg fails/retries"]
  class analyzer remote

  subgraph tools["Dev-only tools"]
    ddbgui["DynamoDB GUI :8001<br/>npm run db:gui"]
    minioconsole["MinIO console :9001<br/>browse uploaded media"]
  end
  class tools tool

  ddbgui --> ddb
  minioconsole --> minio
```

## Dev → prod mapping

| Dev node | How it runs here | Prod equivalent (Terraform, `infra/modules/app`) |
|---|---|---|
| Vite dev server `:5173` | `npm run dev -w frontend`; proxies `/v1`, `/site-code`, `/health` to `:3001` | CloudFront + WAF; static SPA from private S3 (OAC), API paths routed to API Gateway (cache behaviors `/v1/*`, `/site-code`, `/submissions`, `/health`) |
| In-process API router `:3001` | `backend/scripts/local-api.mjs` calls the **exported handlers directly**, fakes `Cognito sub` (`X-Debug-Sub`) | API Gateway HTTP API v2 → single proxy integration → `gnp-api` Lambda (`src/lambda/api.js` dispatches on `event.routeKey`) |
| Handler layer | `backend/src/handlers/*.js`, run in-process, unmodified | Bundled by esbuild into `backend/dist/api/index.mjs` (nodejs22.x, 512 MB, 29 s, reserved concurrency 10) |
| DynamoDB Local `:8000` | Java jar, self-bootstrapped table | `aws_dynamodb_table.app` — single table, `pk`/`sk`, GSIs 1/2/4/5, PITR, KMS, stream |
| ElasticMQ `:9324` | Java jar, queue created by bootstrap | `aws_sqs_queue.submissions` + DLQ (maxReceiveCount 5, KMS) |
| Worker pump | `backend/scripts/local-worker.mjs` polls and dispatches | `aws_lambda_event_source_mapping` → `gnp-worker` Lambda (batch 10, window 0, max concurrency 20, ReportBatchItemFailures) |
| MinIO `:9000` | Binary in `backend/.local/`, CORS set globally by launcher | `aws_s3_bucket.uploads` — private, SSE-KMS, CORS for presigned browser PUTs |
| Analyzer call | **Real remote service**, key from `.env.local` (`ANALYZER_API_KEY`) or Secrets Manager when `ANALYZER_API_KEY_SECRET_ARN` is set | Secrets Manager secret `gnp-*-analyzer-api-key` fetched by the worker; `ANALYZER_BASE_URL` from TF var |
| `description-validation` handler | Needs Bedrock config; **not available locally** — handler reports "missing Bedrock configuration" | `aws_lambda_function.api` env `BEDROCK_MODEL_ID` → Bedrock runtime client |
| Cognito | Not exercised — `X-Debug-Sub` stub instead | `aws_cognito_user_pool.users` + web client (`siteId` custom attr pre-declared for the future JWT authorizer) |

## Notes

- The only two things local dev cannot stand in for are **Bedrock** (description
  validation leg) and **Cognito** (tenant identity). Everything else — routes,
  handlers, table shapes, queue semantics, presigned S3 round trip — is the
  deployed code and topology.
- Media bytes flow browser → MinIO directly via presigned PUT (CORS handled by
  the MinIO launcher), then worker → analyzer. The queue carries only the S3
  key — same invariant as prod.
- `POST /v1/checks` uses the client-minted ULID as `idempotency-key`; replaying
  it flips the item to `duplicate_replay` locally just as prod's conditional
  writes would.