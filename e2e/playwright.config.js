import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { slowMoOptions } from "./helpers/pace.js";
import { E2E_PORTS, E2E_URLS } from "./helpers/ports.js";

const CI = !!process.env.CI;

/*
  The e2e suite drives the real local harness: backend (API + DDB/ElasticMQ/
  MinIO/SF311 fakes) and the Vite dev server (which proxies the API). Playwright boots and tears down both via webServer, plus the analyzer
  stub (helpers/analyzer-stub.mjs) whose base URL flows to the worker through
  ANALYZER_BASE_URL — set here (not in .env.local) so the stub never leaks into
  manual `npm run dev` sessions.

  Env-file loading: npm --workspace scripts resolve the workspace root, so
  backend's --env-file=../.env.local still reads the repo root .env.local even
  though playwright spawns these from the e2e directory (npm resolves -w from
  the workspace root it finds upward). ANALYZER_* overrides are appended as
  explicit env below so they win regardless of file order.

  Table isolation (ADR 0006 addendum): the suite runs against its OWN DynamoDB
  table, gnp-local-e2e — never the developer's gnp-local-app. Setting DYNAMO_TABLE
  here, before .env.local matters, is the single declaration point: the spawned
  backend bootstraps (creates + seeds) it at startup via ensureLocalInfra(), and
  globalSetup inherits the same value for its guards. globalSetup REFUSES to run
  against any other table, so a suite run can neither read nor destroy
  `npm run dev` data.

  Own stack (ADR 0006 addendum, 2026-10-29): every server and emulator the
  suite starts listens on its own port (helpers/ports.js), DynamoDB Local runs
  in memory and MinIO keeps a separate data folder, so the suite runs beside
  `npm run dev` without sharing anything with it. The values below are set on
  process.env (not only on the backend's env) so globalSetup and the specs
  that reach the emulators directly see the same endpoints.
*/
Object.assign(process.env, {
  DYNAMO_TABLE: "gnp-local-e2e",
  LOCAL_API_PORT: String(E2E_PORTS.api),
  LOCAL_ANALYZER_PORT: String(E2E_PORTS.analyzer),
  LOCAL_SF311_PORT: String(E2E_PORTS.sf311),
  LOCAL_DDB_PORT: String(E2E_PORTS.ddb),
  LOCAL_DDB_IN_MEMORY: "true",
  LOCAL_MQ_PORT: String(E2E_PORTS.mq),
  LOCAL_MINIO_API_PORT: String(E2E_PORTS.minio),
  LOCAL_MINIO_CONSOLE_PORT: String(E2E_PORTS.minioConsole),
  LOCAL_MINIO_DATA_DIR: fileURLToPath(
    new URL("../backend/.local/minio-data-e2e", import.meta.url),
  ),
  AWS_ENDPOINT_URL_DYNAMODB: E2E_URLS.ddb,
  DYNAMO_ENDPOINT: E2E_URLS.ddb,
  AWS_ENDPOINT_URL_SQS: E2E_URLS.mq,
  SQS_QUEUE_URL: `${E2E_URLS.mq}/local/gnp-local-e2e-submissions`,
  AWS_ENDPOINT_URL_S3: E2E_URLS.minio,
  SF311_MEDIA_BASE_URL: E2E_URLS.api,
  SF311_CREATESR_URL: `${E2E_URLS.sf311}/createsr`,
  SF311_UPDATESR_URL: `${E2E_URLS.sf311}/updatesr`,
  SF311_AGENCY_LOOKUP_URL: `${E2E_URLS.sf311}/lookup`,
  SF311_LATEST_UPDATES_URL: `${E2E_URLS.sf311}/latest/{agencyID}`,
  API_PROXY_TARGET: E2E_URLS.api,
});

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  // The HTML report carries ramp-check's highlight screenshots (every a11y
  // finding boxed and numbered), so it is written locally too; open it with
  // `npm run a11y:report -w e2e` or `npx playwright show-report`.
  reporter: CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "./test-results",
  use: {
    baseURL: E2E_URLS.app,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: CI ? "retain-on-failure" : "off",
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    // Capture-time device location resolution is best-effort with a 2s
    // timeout; headless Chromium has no geolocation provider, so grant the
    // permission and serve a fixed fix (the seeded site's coordinates).
    permissions: ["geolocation"],
    geolocation: { latitude: 37.76656393517443, longitude: -122.4213267021692 },
    // Headed slow-mo: E2E_SLOW_MS (ms) delays every Playwright action and each
    // keystroke so a human can watch. Unset → instant (headless/CI default).
    ...slowMoOptions,
  },
  webServer: [
    {
      command: "npm run dev -w backend",
      cwd: "..",
      url: `${E2E_URLS.api}/health`,
      // Maximum safety: never attach to a server something else started. The
      // ports are the suite's own, so this only trips when another e2e run is
      // up — Playwright then fails fast with "already used".
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        ANALYZER_BASE_URL: E2E_URLS.analyzer,
        ANALYZER_API_KEY: "e2e-stub-key",
        // Never inherit live Bedrock comparison settings from .env.local.
        // Dedicated duplicate UI scenarios use their own controlled fixtures.
        DUPLICATE_DETECTION_ENABLED: "false",
        DUPLICATE_QUEUE_URL: "",
      },
    },
    {
      command: "node helpers/analyzer-stub.mjs",
      url: `${E2E_URLS.analyzer}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run dev -w frontend -- --port ${E2E_PORTS.app} --strictPort`,
      cwd: "..",
      url: E2E_URLS.app,
      // A dev-started frontend proxies the dev API — never reuse one.
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
