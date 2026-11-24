import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const adminRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: adminRoot,
  publicDir: "public",
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
  },
  build: {
    outDir: resolve(adminRoot, "dist"),
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    environmentOptions: { happyDOM: { url: "http://localhost/sites" } },
    include: ["src/**/*.test.js", "test-support/**/*.test.js"],
    setupFiles: ["test-support/vitest-setup.js"],
    alias: [
      // Web Awesome's components need a real browser; tests stand in their own (admin-dom.js).
      {
        find: /^@awesome\.me\/webawesome\/dist\/components\/.*\.js$/,
        replacement: resolve(adminRoot, "test-support/stubs/web-awesome.js"),
      },
      // The E2E mock imports Playwright only for its fixture; loading it cost each file about 0.3 s.
      {
        find: /^@playwright\/test$/,
        replacement: resolve(adminRoot, "test-support/stubs/playwright.js"),
      },
    ],
    // A spy or stubbed global left in place would change what the next test's page does.
    restoreMocks: true,
    unstubGlobals: true,
    // setImmediate stays real, since settle() in admin-dom.js waits on it.
    // Date moves with tick(), so cache windows don't depend on how fast a test runs.
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    },
    testTimeout: 10_000,
    // Each worker holds a few hundred MB of DOM; one core stays free for the
    // main process on a small machine.
    maxWorkers: Math.max(1, Math.min(4, availableParallelism() - 1)),
    execArgv: ["--max-old-space-size=1024"],
    // `npm run test:admin:coverage` gives the before/after figures REVIEW.md asks for.
    coverage: {
      provider: "v8",
      include: ["src/**/*.js"],
      exclude: ["src/**/*.test.js"],
    },
  },
});
