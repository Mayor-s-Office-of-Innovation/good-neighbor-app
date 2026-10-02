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
*/
export default defineConfig({
  globalSetup: "./global-setup.mjs",
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : "list",
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
      reuseExistingServer: !CI,
      timeout: 120_000,
      env: {
        ...process.env,
        ANALYZER_BASE_URL: "http://127.0.0.1:3101",
        ANALYZER_API_KEY: "e2e-stub-key",
      },
    },
    {
      command: "node helpers/analyzer-stub.mjs",
      url: "http://127.0.0.1:3101/healthz",
      reuseExistingServer: !CI,
      timeout: 30_000,
    },
    {
      command: "npm run dev -w frontend",
      cwd: "..",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
  ],
});
