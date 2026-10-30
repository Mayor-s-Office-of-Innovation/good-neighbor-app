import { defineConfig } from "@playwright/test";
export default defineConfig({
  outputDir: "./test-results/support",
  testDir: "./support-tests",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:5178",
    headless: true,
    ...(process.env.SUPPORT_TEST_CHROME ? { channel: "chrome" } : {}),
  },
  webServer: {
    command:
      "../node_modules/.bin/vite --config vite.config.js --host 127.0.0.1 --port 5178 --strictPort",
    cwd: "../frontend",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: false,
  },
});
