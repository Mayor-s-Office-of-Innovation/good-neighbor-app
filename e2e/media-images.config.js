import { defineConfig } from "@playwright/test";
import { e2ePort } from "./helpers/ports.mjs";

const port = await e2ePort("E2E_MEDIA_PORT", 5181);
// Frontend-only regression checks: all API/media traffic is intercepted locally.
export default defineConfig({
  testDir: "./tests",
  testMatch: "media-images.spec.js",
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `npm run dev -w frontend -- --port ${port} --strictPort`,
    cwd: "..",
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
