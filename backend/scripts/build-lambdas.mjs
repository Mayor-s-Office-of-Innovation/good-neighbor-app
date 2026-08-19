// Bundle the Lambda entrypoints into deployable artifacts for Terraform's
// `data.archive_file` to zip. Each entrypoint is bundled with its imports (incl.
// the AWS SDK, which pins the version and keeps cold starts predictable) into a
// single ESM file at `dist/<name>/index.mjs`. The Lambda handler is `index.handler`.
//
// Run before `terraform plan` in the deploy job — the archive's source_code_hash
// drives redeploys. `sharp` is intentionally not pulled in (downscaleImage is
// still a passthrough), so there is no native binary to package this pass.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { rm } from "node:fs/promises";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(backendRoot, "dist");

/** @type {import("esbuild").BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  logLevel: "info",
  // ESM output that bundles CJS deps needs `require`/`__dirname` shimmed; some
  // AWS SDK internals reference them.
  banner: {
    js: [
      "import { createRequire as __cr } from 'module';",
      "import { fileURLToPath as __fp } from 'url';",
      "import { dirname as __dn } from 'path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __fp(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join(""),
  },
};

const entries = [
  { name: "api", entry: resolve(backendRoot, "src/lambda/api.js") },
  { name: "worker", entry: resolve(backendRoot, "src/lambda/worker.js") },
];

await rm(distDir, { recursive: true, force: true });

for (const { name, entry } of entries) {
  await build({
    ...shared,
    entryPoints: [entry],
    outfile: resolve(distDir, name, "index.mjs"),
  });
  console.log(`[build-lambdas] bundled ${name} → dist/${name}/index.mjs`);
}
