import { defineConfig } from "@playwright/test";
import { e2ePort } from "./helpers/ports.mjs";

const port = await e2ePort("E2E_SUPPORT_PORT", 5178);
export default defineConfig({
  testDir: "./support-tests",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    headless: true,
    ...(process.env.SUPPORT_TEST_CHROME ? { channel: "chrome" } : {}),
  },
  webServer: {
    command: `../node_modules/.bin/vite --config vite.config.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: "../frontend",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
