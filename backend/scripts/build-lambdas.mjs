// Bundle the Lambda entrypoints into deployable artifacts for Terraform's
// `data.archive_file` to zip. Each entrypoint is bundled with its imports (incl.
// the AWS SDK, which pins the version and keeps cold starts predictable) into a
// single ESM file at `dist/<name>/index.mjs`. The Lambda handler is `index.handler`.
//
// Run before `terraform plan` in the deploy job — the archive's source_code_hash
// drives redeploys.
//
// `sharp` (native image codec used by the worker's downscale step) is handled
// specially: esbuild keeps it external (it's a `.node` native addon and must
// not be bundled), and this script copies `sharp`, its JS runtime dependencies
// (`detect-libc`, `semver` — imported by sharp's module-load path), and its
// platform binaries (`@img/*`) from node_modules into `dist/worker/` so the zip
// is self-contained. Only the worker imports it — api/authorizer bundles are
// unchanged. On the deploy runner, `npm ci` resolves the linux-x64 binaries via
// sharp's optionalDependencies.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { rm, cp } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

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
  {
    name: "authorizer",
    entry: resolve(backendRoot, "src/lambda/authorizer.js"),
  },
  {
    name: "worker",
    entry: resolve(backendRoot, "src/lambda/worker.js"),
    // Native addons can't be bundled — keep the import as a runtime require
    // resolved against the copied node_modules (see copy step below).
    external: ["sharp"],
  },
];

await rm(distDir, { recursive: true, force: true });

for (const { name, entry, external } of entries) {
  await build({
    ...shared,
    entryPoints: [entry],
    outfile: resolve(distDir, name, "index.mjs"),
    ...(external ? { external } : {}),
  });
  console.log(`[build-lambdas] bundled ${name} → dist/${name}/index.mjs`);
}

// Copy sharp + its runtime deps + platform binaries into the worker dist so the
// deploy zip ships them alongside the bundle. npm hoists sharp to the workspace
// root, so resolve from there (falling back to backend/node_modules if not
// hoisted). Resolution inside the zip walks up from
// dist/worker/node_modules/sharp/... — there is no parent node_modules — so
// every package sharp's module-load path imports must exist in the copy.
//
// Only the linux-x64 binaries are needed at runtime (Lambda), but the local
// node_modules only carries this machine's binaries. Copy ALL of @img/*: on the
// deploy runner `npm ci` resolves linux-x64 via sharp's optionalDependencies,
// and each platform package self-describes its os/cpu, so extras are inert.
// The wasm32 fallback (~9 MB) is what sharp loads if no native binary matches,
// so it doubles as insurance against an os/cpu mismatch in the zip.
const sharpDist = resolve(distDir, "worker");
const roots = [resolve(backendRoot, ".."), backendRoot];
const findPkg = (pkg) =>
  roots.map((root) => resolve(root, "node_modules", pkg)).find(existsSync);

const sharpSrc = findPkg("sharp");
if (!sharpSrc) {
  console.warn("[build-lambdas] sharp not present in node_modules — skipping");
} else {
  // sharp's runtime `dependencies` (detect-libc, semver) must ride along —
  // libvips.mjs imports them at module load and the zip has no fallback.
  const sharpPkg = JSON.parse(
    readFileSync(join(sharpSrc, "package.json"), "utf8"),
  );
  const runDeps = Object.keys(sharpPkg.dependencies ?? {});
  await cp(sharpSrc, join(sharpDist, "node_modules", "sharp"), {
    recursive: true,
  });
  const imgSrc = findPkg("@img");
  if (imgSrc) {
    await cp(imgSrc, join(sharpDist, "node_modules", "@img"), {
      recursive: true,
    });
  } else {
    console.warn("[build-lambdas] @img not present in node_modules — skipping");
  }
  for (const dep of runDeps) {
    const src = findPkg(dep);
    if (!src) {
      throw new Error(
        `[build-lambdas] sharp runtime dependency '${dep}' not found in node_modules — the worker zip would crash on cold start`,
      );
    }
    await cp(src, join(sharpDist, "node_modules", dep), { recursive: true });
  }
  console.log(
    `[build-lambdas] copied sharp + [${runDeps.join(", ")}] + @img/* into dist/worker/node_modules/`,
  );
}
