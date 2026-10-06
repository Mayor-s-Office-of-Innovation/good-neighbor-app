import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const adminRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: adminRoot,
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
  },
  build: {
    outDir: resolve(adminRoot, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(adminRoot, "index.html"),
        analytics: resolve(adminRoot, "analytics.html"),
      },
    },
  },
});
