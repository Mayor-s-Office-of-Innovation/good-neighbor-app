import { defineConfig, devices } from "@playwright/test";
import { e2ePort } from "./helpers/ports.mjs";

const port = await e2ePort("E2E_UPDATES_PORT", 5179);
export default defineConfig({
  outputDir: "./test-results/task-updates",
  testDir: "./task-update-tests",
  workers: 1,
  timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  projects: [
    {
      name: "chromium",
      use: {
        ...(process.env.UPDATE_TEST_CHROME ? { channel: "chrome" } : {}),
        viewport: { width: 390, height: 844 },
      },
    },
    { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
  webServer: {
    command: `../node_modules/.bin/vite --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../frontend",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
