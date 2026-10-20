import { defineConfig } from "@playwright/test";
import { slowMoOptions } from "./helpers/pace.js";

const CI = !!process.env.CI;

/*
  The e2e suite drives the real local harness: backend (API + DDB/ElasticMQ/
  MinIO/SF311 fakes on :3001) and the Vite dev server (:5173, which proxies the
  API). Playwright boots and tears down both via webServer, plus the analyzer
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
  globalSetup/globalTeardown inherit the same value for their guards. globalSetup
  REFUSES to run against any other table, and globalTeardown deletes this one, so
  a suite run can neither read nor destroy `npm run dev` data.
*/
process.env.DYNAMO_TABLE = "gnp-local-e2e";

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
  reporter: CI ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:5173",
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
      url: "http://127.0.0.1:3001/health",
      // Maximum safety: never attach to a server a developer started (it would
      // carry the dev table's env). If ports are occupied, Playwright fails
      // fast with "port in use" — stop the dev stack, then run the suite.
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        ANALYZER_BASE_URL: "http://127.0.0.1:3101",
        ANALYZER_API_KEY: "e2e-stub-key",
        // Never inherit live Bedrock comparison settings from .env.local.
        // Dedicated duplicate UI scenarios use their own controlled fixtures.
        DUPLICATE_DETECTION_ENABLED: "false",
        DUPLICATE_QUEUE_URL: "",
        SQS_QUEUE_URL: "http://localhost:9324/local/gnp-local-e2e-submissions",
      },
    },
    {
      command: "node helpers/analyzer-stub.mjs",
      url: "http://127.0.0.1:3101/healthz",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run dev -w frontend",
      cwd: "..",
      url: "http://127.0.0.1:5173",
      // The frontend proxies whatever listens on :3001 — reusing a dev-started
      // frontend could route the suite at the dev table's API.
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
