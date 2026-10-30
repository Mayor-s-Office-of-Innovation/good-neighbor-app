import { defineConfig } from "@playwright/test";

/*
  The offline-launch service worker only exists in a `vite build`, so these
  tests run against `npm run dev:offline` (build + preview) instead of the dev
  server the main suite uses. No backend: they cover the app shell only.
*/
export default defineConfig({
  outputDir: "./test-results/offline-shell",
  testDir: "./offline-shell-tests",
  workers: 1,
  timeout: 120_000,
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "npm run dev:offline -w frontend",
    cwd: "..",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
