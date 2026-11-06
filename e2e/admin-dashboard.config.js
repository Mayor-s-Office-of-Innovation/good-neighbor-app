import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// 5185 is free of the other suites' ports; set ADMIN_E2E_PORT to run two worktrees at once.
const port = Number(process.env.ADMIN_E2E_PORT || 5185);
const vite =
  "../node_modules/.bin/vite --config ../admin-frontend/vite.config.js";
const dist = fileURLToPath(
  new URL(`./test-results/admin-dashboard-dist-${port}`, import.meta.url),
);
// Coverage maps hits to source files, which only the dev server serves; otherwise a
// built bundle loads each page several times faster than Vite's unbundled modules.
const server = process.env.ADMIN_E2E_COVERAGE_DIR
  ? `${vite} --port ${port} --strictPort`
  : `${vite} build --outDir ${dist} --logLevel warn && ${vite} preview --outDir ${dist} --host 127.0.0.1 --port ${port} --strictPort`;

export default defineConfig({
  outputDir: "./test-results/admin-dashboard",
  testDir: "./admin-tests",
  // A stray test.only would otherwise run one test and still pass the required check.
  forbidOnly: !!process.env.CI,
  // Every test builds its own mock and data, so tests in one file can run at once.
  fullyParallel: true,
  // Playwright's default is half the cores: 2 on CI's 4-core runner, which doubles the wait.
  workers: process.env.CI ? 4 : 2,
  timeout: 30000,
  reportSlowTests: { max: 5, threshold: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Playwright's own headless Chromium, as in CI; Chrome took over twice as long per test.
    headless: true,
    // CI uploads outputDir, which is empty without a trace.
    trace: "retain-on-failure",
    // Dates format with the browser's locale and zone, so pin them as the main suite does.
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  },
  webServer: {
    command: server,
    url: `http://127.0.0.1:${port}`,
    // Reusing a server on this port could test another worktree's main.js.
    reuseExistingServer: false,
  },
});
