import { defineConfig } from "@playwright/test";
// Frontend-only regression checks: all API/media traffic is intercepted locally.
export default defineConfig({
  outputDir: "./test-results/media-images",
  testDir: "./tests",
  testMatch: "media-images.spec.js",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5181" },
  webServer: {
    command: "npm run dev -w frontend -- --port 5181",
    cwd: "..",
    url: "http://127.0.0.1:5181",
    reuseExistingServer: false,
  },
});
