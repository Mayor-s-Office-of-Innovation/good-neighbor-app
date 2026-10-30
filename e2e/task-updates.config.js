import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  outputDir: "./test-results/task-updates",
  testDir: "./task-update-tests",
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5179", headless: true },
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
    command:
      "../node_modules/.bin/vite --host 127.0.0.1 --port 5179 --strictPort",
    cwd: "../frontend",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
  },
});
