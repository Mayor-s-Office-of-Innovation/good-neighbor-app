# Development environment architecture

How the app runs **locally** (`npm run dev`), and how each local piece maps to the
AWS resource it stands in for. The guiding principle (see
[ADR 0006](adr/0006-docker-free-local-dev-harness.md)) is that the local harness runs the
**exact handler + worker code we deploy to Lambda**, against Docker-free emulators reached
through the same AWS SDK clients via endpoint env vars. Terraform stays the source of truth
for real wiring; the harness only answers *"does my handler work."*

---

## 1. Infrastructure & process topology

What actually runs on your machine, on which ports, and its production equivalent.

```mermaid
flowchart LR
  subgraph dev["Your machine — local dev"]
    direction LR

    subgraph browser["Browser"]
      spa["SPA (web components)<br/>services/api.js · onboarding.js<br/>BASE = '' → same-origin"]
    end

    subgraph viteproc["npm run dev -w frontend"]
      vite["Vite dev server :5173<br/>serves SPA + proxies API<br/>/v1 · /site-code · /health → :3001"]
    end

    subgraph backendproc["npm run dev -w backend (concurrently)"]
      direction TB
      api["local-api.mjs :3001<br/>in-process HTTP router<br/>builds APIGatewayProxyEventV2<br/>→ calls handler(event)"]
      worker["local-worker.mjs<br/>SQS long-poll pump<br/>receive → handler → delete"]
      ddb[("DynamoDB Local :8000<br/>single-table 'gnp-local-app'")]
      mq[["ElasticMQ :9324<br/>queue 'gnp-local-submissions'"]]
      minio[("MinIO :9000 (console :9001)<br/>bucket 'gnp-local-uploads'")]
      boot["ensure-infra.mjs<br/>creates table + queue + bucket<br/>seeds site codes 123-456 / 000-000"]
    end

    gui["dynamodb-admin GUI :8001<br/>(npm run db:gui, 2nd terminal)"]
  end

  analyzer["Street Conditions Analyzer<br/>REAL deployed service<br/>POST /v1/analyses (x-api-key)"]

  spa -- "fetch same-origin /v1/*, /site-code" --> vite
  vite -- "proxy → 127.0.0.1:3001" --> api
  spa -- "presigned PUT / GET (cross-origin, CORS)" --> minio

  api -- "@aws-sdk/lib-dynamodb" --> ddb
  api -- "SendMessage (register, submissions)" --> mq
  api -- "presign PUT/GET URLs" --> minio

  worker -- "ReceiveMessage / DeleteMessage" --> mq
  worker -- "getObjectBytes (read media)" --> minio
  worker -- "put ANALYSIS# + bump header" --> ddb
  worker -- "downscale → base64 → analyze" --> analyzer

  boot -. bootstraps .-> ddb
  boot -. bootstraps .-> mq
  boot -. bootstraps .-> minio
  gui -. browse .-> ddb

  classDef emu fill:#e8f0fe,stroke:#4285f4,color:#1a1a1a;
  classDef proc fill:#fff4e5,stroke:#f5a623,color:#1a1a1a;
  classDef real fill:#fde8e8,stroke:#d64545,color:#1a1a1a;
  class ddb,mq,minio emu;
  class api,worker,vite proc;
  class analyzer real;
```

### Local ↔ production mapping

| Local (dev) | Stands in for (prod) | Notes |
|---|---|---|
| Vite dev server `:5173` + proxy | S3 + CloudFront (SPA hosting) | Prod SPA & API share **one** CloudFront distro, so `BASE=""` and paths stay relative in both. |
| `local-api.mjs` in-process router `:3001` | API Gateway (HTTP API v2) + **one** API Lambda | Router table mirrors `src/lambda/api.js` route keys and the Terraform routes — keep all three in step. |
| `local-worker.mjs` poll pump | SQS **event-source mapping** → worker Lambda | Picks handler by message shape; deletes only on success (throw ⇒ redelivery), like real SQS. |
| DynamoDB Local `:8000` | DynamoDB single table | `ensure-infra.mjs` table schema kept in lockstep with the Terraform `aws_dynamodb_table`. |
| ElasticMQ `:9324` | SQS | Both `/submissions` demo flow and analyze flow share the one queue. |
| MinIO `:9000` | S3 (uploads bucket) | Enables the presigned-PUT leg + worker read-back with no real AWS; path-style addressing. |
| `X-Debug-Sub` header / `DEBUG_SUB` | Cognito JWT authorizer (`sub`) | Auth is **stubbed** locally; the router injects a fake principal. |
| **(none — real service)** | Street Conditions Analyzer | The analyze worker calls the **actual deployed** analyzer in dev too; needs a real `ANALYZER_API_KEY`. |
| Bedrock stub (`BEDROCK_*`) | Amazon Bedrock | Mocked locally; real model calls happen inside the analyzer service / cloud dev env only. |

The SDK clients (`db.js`, `s3.js`, `artifacts.js`'s SQS client) need **no code change** to hit
emulators — `AWS_ENDPOINT_URL_DYNAMODB` / `_SQS` / `_S3` in `.env.local` redirect them.

---

## 2. Request routing map — frontend call → handler → resources

Every route the SPA hits, the handler behind it, and the backing resources it touches. One
Lambda backs every route in prod (`src/lambda/api.js`); locally the router dispatches to the
same exported handlers.

```mermaid
flowchart LR
  subgraph fe["frontend/src/services"]
    onb["onboarding.validateSetupCode"]
    cCreate["api.createCheck"]
    cUp["api.uploadArtifact<br/>(presign → PUT → register)"]
    cGet["api.getCheck / listChecks"]
    cComplete["api.completeCheck"]
    cMedia["api.getMediaUrl"]
    cEval["api.evaluateAssessment /<br/>getAssessmentGuidance"]
    cTasks["api.listTasks / completeTask /<br/>cannotDoTask"]
  end

  subgraph handlers["backend/src/handlers"]
    hSite["site-code.handler"]
    hChecks["checks: createCheck /<br/>listChecks / getCheck / completeCheck"]
    hArt["artifacts: presignUpload /<br/>registerArtifact / presignMedia"]
    hGuid["guidance: evaluate / getGuidance /<br/>completeTask / cannotDoTask"]
    hTasks["tasks.listTasks"]
  end

  subgraph res["Resources"]
    ddb[("DynamoDB")]
    s3[("S3 / MinIO")]
    sqs[["SQS / ElasticMQ"]]
    az["Analyzer (async)"]
  end

  onb -->|"POST /site-code"| hSite --> ddb

  cCreate -->|"POST /v1/checks"| hChecks
  cGet -->|"GET /v1/checks{/id}"| hChecks
  cComplete -->|"POST .../complete"| hChecks
  hChecks --> ddb

  cUp -->|"POST .../artifacts:presign"| hArt
  cUp -->|"PUT bytes (direct)"| s3
  cUp -->|"POST .../artifacts"| hArt
  cMedia -->|"GET .../media"| hArt
  hArt -->|"presign PUT/GET"| s3
  hArt -->|"put ART# item"| ddb
  hArt -->|"enqueue analyze msg (s3Key, not bytes)"| sqs

  cEval -->|"POST /v1/assessments:evaluate + guidance"| hGuid --> ddb
  cTasks -->|"GET /v1/tasks · POST .../complete · .../cannot-do"| hTasks --> ddb

  sqs -.->|"worker consumes"| az

  classDef r fill:#e8f0fe,stroke:#4285f4,color:#1a1a1a;
  class ddb,s3,sqs,az r;
```

Key invariants visible above:

- **`siteId` is never sent by the client** — it's derived server-side from the principal (the
  stubbed `sub` locally) and enforced as the DynamoDB partition key.
- **Media bytes never transit the API.** The device PUTs straight to S3/MinIO via a presigned
  URL; `registerArtifact` enqueues only the **S3 key**, and the worker fetches the bytes.
- The client mints `checkId` and sends it as the `idempotency-key`, so every write is replayable.

---

## 3. The full media loop (submit a perimeter check)

The end-to-end async path — the one flow that exercises every resource. This is
`services/submit-check.js` orchestrating `services/api.js`, then the worker running in the
background.

```mermaid
sequenceDiagram
  autonumber
  participant FE as SPA (browser)
  participant PX as Vite proxy :5173
  participant API as local-api :3001<br/>(→ handlers)
  participant DDB as DynamoDB :8000
  participant S3 as MinIO :9000
  participant Q as ElasticMQ :9324
  participant W as local-worker
  participant AZ as Analyzer (remote)

  Note over FE: user finishes the walk, taps submit
  FE->>PX: POST /v1/checks (idempotency-key = checkId)
  PX->>API: proxy
  API->>DDB: Put CHECK header (conditional)
  API-->>FE: 200 { checkId, status }

  loop per photo
    FE->>API: POST .../artifacts:presign { side, contentType }
    API->>S3: presign PUT (key + content-type pinned)
    API-->>FE: 200 { artifactId, s3Key, uploadUrl }
    FE->>S3: PUT bytes (direct, cross-origin CORS)
    S3-->>FE: 200
    FE->>API: POST .../artifacts { artifactId, s3Key, ... }
    API->>DDB: Put ART# item (attribute_not_exists)
    API->>Q: SendMessage { checkId, artifactId, s3Key }
    API-->>FE: 202 queued
  end

  par worker drains the queue (background)
    W->>Q: ReceiveMessage (long-poll)
    Q-->>W: analyze message (s3Key, no bytes)
    W->>S3: getObjectBytes(s3Key)
    W->>W: downscale + base64
    W->>AZ: POST /v1/analyses (x-api-key, store_input:false)
    AZ-->>W: scorecard
    W->>DDB: Put ANALYSIS# (idempotent) + bump header counters
    W->>Q: DeleteMessage (only on success)
  and FE waits for analyses to land
    loop until every artifact has an ANALYSIS# (bounded poll)
      FE->>API: GET /v1/checks/{checkId}
      API->>DDB: Query check + artifacts + analyses
      API-->>FE: { check, artifacts, analyses }
    end
  end

  FE->>API: POST /v1/checks/{checkId}/complete
  API->>DDB: read analyses → fold scorecard → write assessment
  API-->>FE: 200 { grade, issueCount, assessment }
  Note over FE: results screen renders findings —<br/>guidance/tasks minted on "Continue"
```

### Why it's shaped this way

- **Presign → direct PUT → register** keeps large image bytes off the API Lambda entirely (cost,
  payload limits, and the analyzer never retains media — GNP owns retention in its own bucket).
- **Async via SQS** decouples the slow part (downscale + remote LLM, ~seconds per photo) from the
  request path. The worker fans out a batch concurrently, so wall-clock ≈ the slowest photo.
- **Idempotency everywhere** (conditional writes on `checkId`, `artifactId`, `ANALYSIS#` sort key)
  means a lost 202, a redelivered SQS message, or a resumed submit can't double-count or corrupt
  the folded scorecard.
- The client `waitForAnalyses` poll **throws** on timeout rather than completing on partial
  coverage, because `complete` freezes the scorecard idempotently — a silent partial would be
  permanent.

---

*Sources: `frontend/vite.config.js`, `frontend/src/services/{api,onboarding,submit-check}.js`,
`backend/src/lambda/{api,worker}.js`, `backend/src/handlers/*`, `backend/src/workers/analyze-artifact.js`,
`backend/scripts/{local-api,local-worker,local-minio}.mjs`, `backend/scripts/lib/ensure-infra.mjs`,
`.env.example`, `docs/dev-commands.md`, `docs/adr/0006-docker-free-local-dev-harness.md`.*
