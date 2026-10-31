import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./capture-media-tests",
  outputDir: "./test-results/capture-media",
  workers: 1,
  timeout: 60000,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  use: {
    baseURL: "http://127.0.0.1:5179",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command:
      "../node_modules/.bin/vite --host 127.0.0.1 --port 5179 --strictPort",
    cwd: "../frontend",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: true,
  },
});
