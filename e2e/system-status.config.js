import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./status-tests",
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:5176", channel: "chrome", headless: true },
  webServer: {
    command:
      "../node_modules/.bin/vite --config ../admin-frontend/vite.config.js --port 5176",
    url: "http://127.0.0.1:5176",
    reuseExistingServer: true,
  },
});
