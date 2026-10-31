import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./recovery-tests",
  outputDir: "./test-results/recovery",
  workers: 1,
  timeout: 45_000,
  use: { baseURL: "http://127.0.0.1:5182", headless: true },
  projects: [
    { name: "chromium", use: { viewport: { width: 390, height: 844 } } },
    { name: "webkit", use: { ...devices["iPhone 13"], browserName: "webkit" } },
  ],
  webServer: {
    command:
      "../node_modules/.bin/vite --host 127.0.0.1 --port 5182 --strictPort",
    cwd: "../frontend",
    url: "http://127.0.0.1:5182",
    reuseExistingServer: false,
  },
});
