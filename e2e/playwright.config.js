import { defineConfig } from "@playwright/test";
import { slowMoOptions } from "./helpers/pace.js";
import { configureRunResources } from "./helpers/run-resources.mjs";
import { e2ePort } from "./helpers/ports.mjs";

const CI = !!process.env.CI;

/*
  The e2e suite drives the real local harness: backend (API + DDB/ElasticMQ/
  MinIO/SF311 fakes on :3001) and the Vite dev server (:5173, which proxies the
  API). Playwright boots and tears down both via webServer, plus the analyzer
  stub (helpers/analyzer-stub.mjs) whose base URL flows to the worker through
  ANALYZER_BASE_URL — set here (not in .env.local) so the stub never leaks into
  manual `npm run dev` sessions.

  Running beside `npm run dev`: the API, analyzer stub and Vite move to the next
  free port when the usual one is taken (helpers/ports.mjs), and the shared
  DDB/ElasticMQ/MinIO/SF311 services are reused when already running — the suite
  keeps to its own table and queue (below).

  Env-file loading: npm --workspace scripts resolve the workspace root, so
  backend's --env-file=../.env.local still reads the repo root .env.local even
  though playwright spawns these from the e2e directory (npm resolves -w from
  the workspace root it finds upward). ANALYZER_* overrides are appended as
  explicit env below so they win regardless of file order.

  Table isolation (ADR 0006 addendum): the suite runs against its OWN DynamoDB
  table, gnp-local-e2e-<runId> — never the developer's gnp-local-app. Setting DYNAMO_TABLE
  here, before .env.local matters, is the single declaration point: the spawned
  backend bootstraps (creates + seeds) it at startup via ensureLocalInfra(), and
  globalSetup/globalTeardown inherit the same value for their guards. globalSetup
  REFUSES to run against any other table, and globalTeardown deletes this one, so
  a suite run can neither read nor destroy `npm run dev` data.
*/
const resources = configureRunResources();

const apiPort = await e2ePort("E2E_API_PORT", 3001);
const analyzerPort = await e2ePort("E2E_ANALYZER_PORT", 3101);
const appPort = await e2ePort("E2E_APP_PORT", 5173);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const analyzerUrl = `http://127.0.0.1:${analyzerPort}`;
const appUrl = `http://127.0.0.1:${appPort}`;

export default defineConfig({
  globalSetup: "./global-setup.mjs",
  globalTeardown: "./global-teardown.mjs",
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
    baseURL: appUrl,
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
      url: `${apiUrl}/health`,
      // Maximum safety: never attach to a server a developer started (it would
      // carry the dev table's env). The ports above are picked free, so the
      // suite always boots its own.
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        LOCAL_API_PORT: String(apiPort),
        SF311_MEDIA_BASE_URL: apiUrl,
        ANALYZER_BASE_URL: analyzerUrl,
        ANALYZER_API_KEY: "e2e-stub-key",
        // Never inherit live Bedrock comparison settings from .env.local.
        // Dedicated duplicate UI scenarios use their own controlled fixtures.
        DUPLICATE_DETECTION_ENABLED: "false",
        // A developer's admin-seed setting skips the normal site-code seeds.
        // The E2E suite always needs its own standard fixture sites.
        LOCAL_SITE_ADMIN_SEED: "false",
        DUPLICATE_QUEUE_URL: "",
        SQS_QUEUE_URL: resources.queueUrl,
      },
    },
    {
      command: "node helpers/analyzer-stub.mjs",
      url: `${analyzerUrl}/healthz`,
      env: { ...process.env, LOCAL_ANALYZER_PORT: String(analyzerPort) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `npm run dev -w frontend -- --port ${appPort} --strictPort`,
      cwd: "..",
      url: appUrl,
      env: { ...process.env, API_PROXY_TARGET: apiUrl },
      // Reusing a dev-started frontend could route the suite at the dev
      // table's API.
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
