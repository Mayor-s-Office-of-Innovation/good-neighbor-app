// Bundle the Lambda entrypoints into deployable artifacts for Terraform's
// `data.archive_file` to zip. Each entrypoint is bundled with its imports (incl.
// the AWS SDK, which pins the version and keeps cold starts predictable) into a
// single ESM file at `dist/<name>/index.mjs`. The Lambda handler is `index.handler`.
//
// Run before `terraform plan` in the deploy job — the archive's source_code_hash
// drives redeploys.
//
// `sharp` (native image codec used by the API and worker downscale steps) is
// handled specially: esbuild keeps it external (it's a `.node` native addon and
// must not be bundled), and this script copies `sharp`, its JS runtime
// dependencies (`detect-libc`, `semver` — imported by sharp's module-load
// path), and its platform binaries (`@img/*`) from node_modules into both
// deployment artifacts so their zips are self-contained. On the deploy runner,
// `npm ci` resolves the linux-x64 binaries via sharp's optionalDependencies.
//
// `@duckdb/node-api` (analytics convert + report lambdas) gets the same
// treatment: native `.node` binding + platform-specific `libduckdb.dylib` in
// `@duckdb/node-bindings-<platform>`, kept external and copied into
// dist/analytics-convert/ and dist/analytics-report/. On the deploy runner
// `npm ci` resolves the linux binaries via the platform packages'
// optionalDependencies (same mechanism as @img/*).

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { rm, cp, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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
  {
    name: "api",
    entry: resolve(backendRoot, "src/lambda/api.js"),
    // Native addons can't be bundled — keep the import as a runtime require
    // resolved against the copied node_modules (see copy step below).
    external: ["sharp"],
  },
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
  {
    name: "analytics-export",
    entry: resolve(backendRoot, "src/lambda/analytics-export.js"),
  },
  {
    name: "analytics-convert",
    entry: resolve(backendRoot, "src/lambda/analytics-convert.js"),
    // DuckDB native binding + platform dylib (see copy step below).
    external: ["@duckdb/node-api", "@duckdb/node-bindings"],
  },
  {
    name: "analytics-report",
    entry: resolve(backendRoot, "src/lambda/analytics-report.js"),
    external: ["@duckdb/node-api", "@duckdb/node-bindings"],
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

// Copy sharp + its runtime deps + platform binaries into every Lambda that
// imports it so each deploy zip ships them alongside the bundle. npm hoists
// sharp to the workspace root, so resolve from there (falling back to
// backend/node_modules if not hoisted). Resolution inside each zip walks up
// from dist/<target>/node_modules/sharp/... — there is no parent node_modules —
// so every package sharp's module-load path imports must exist in the copy.
//
// Only the linux-x64 binaries are needed at runtime (Lambda), but the local
// node_modules only carries this machine's binaries. Copy ALL of @img/*: on the
// deploy runner `npm ci` resolves linux-x64 via sharp's optionalDependencies,
// and each platform package self-describes its os/cpu, so extras are inert.
// The wasm32 fallback (~9 MB) is what sharp loads if no native binary matches,
// so it doubles as insurance against an os/cpu mismatch in the zip.
const sharpTargets = ["api", "worker"];
const roots = [resolve(backendRoot, ".."), backendRoot];
const findPkg = (pkg) =>
  roots.map((root) => resolve(root, "node_modules", pkg)).find(existsSync);

const sharpSrc = findPkg("sharp");
if (!sharpSrc) {
  throw new Error(
    "[build-lambdas] sharp not found in node_modules — the api and worker zips would crash on cold start",
  );
} else {
  // sharp's runtime `dependencies` (detect-libc, semver) must ride along —
  // libvips.mjs imports them at module load and the zip has no fallback.
  const sharpPkg = JSON.parse(
    readFileSync(join(sharpSrc, "package.json"), "utf8"),
  );
  const runDeps = Object.keys(sharpPkg.dependencies ?? {});
  const imgSrc = findPkg("@img");
  if (!imgSrc) {
    throw new Error(
      "[build-lambdas] @img not found in node_modules — the api and worker zips would crash on cold start",
    );
  }
  for (const target of sharpTargets) {
    const sharpDist = resolve(distDir, target);
    await cp(sharpSrc, join(sharpDist, "node_modules", "sharp"), {
      recursive: true,
    });
    await cp(imgSrc, join(sharpDist, "node_modules", "@img"), {
      recursive: true,
    });
    for (const dep of runDeps) {
      const src = findPkg(dep);
      if (!src) {
        throw new Error(
          `[build-lambdas] sharp runtime dependency '${dep}' not found in node_modules — the ${target} zip would crash on cold start`,
        );
      }
      await cp(src, join(sharpDist, "node_modules", dep), { recursive: true });
    }
    console.log(
      `[build-lambdas] copied sharp + [${runDeps.join(", ")}] + @img/* into dist/${target}/node_modules/`,
    );
  }
}

// Copy @duckdb/node-api + its native bindings into the two analytics dists.
// Same resolution logic as sharp: workspace-root node_modules first.
//
// The bindings package (@duckdb/node-bindings) loads its platform binary
// (@duckdb/node-bindings-<os>-<cpu>) via os/cpu-gated optionalDependencies and
// requires `detect-libc` at module load — every runtime dependency must ride
// along (same rule as sharp's copy), and ONLY the platform package matching the
// Lambda target architecture is copied: each libduckdb binary is ~67 MB
// (~22 MB zipped), so copying every installed variant would blow Lambda's 50 MB
// direct-upload zip limit on the Linux deploy runner (which resolves several
// platform packages at once).
const duckTargets = ["analytics-convert", "analytics-report"];
// Lambda nodejs22.x runs on x86_64 glibc (AL2023) unless explicitly configured
// for arm64 — keep this in sync with the Terraform Lambda architectures.
const LAMBDA_TARGET = process.env.ANALYTICS_LAMBDA_ARCH ?? "linux-x64";
const duckApiSrc = findPkg("@duckdb/node-api");
if (!duckApiSrc) {
  console.warn(
    "[build-lambdas] @duckdb/node-api not present in node_modules — skipping",
  );
} else {
  const bindingsPkgSrc = findPkg("@duckdb/node-bindings");
  if (!bindingsPkgSrc) {
    throw new Error(
      "[build-lambdas] @duckdb/node-bindings not found in node_modules — the analytics zips would crash on cold start",
    );
  }
  // @duckdb/node-bindings' runtime dependencies (detect-libc — required at
  // module load) must ride along, read from its package.json like sharp's.
  const bindingsPkg = JSON.parse(
    readFileSync(join(bindingsPkgSrc, "package.json"), "utf8"),
  );
  const bindingsDeps = Object.keys(bindingsPkg.dependencies ?? {});

  // The platform binary package: only the one matching the Lambda target.
  const scopeDir = resolve(duckApiSrc, ".."); // …/node_modules/@duckdb
  const targetPkg = `node-bindings-${LAMBDA_TARGET}`;
  const targetPkgPath = existsSync(scopeDir)
    ? readdirSync(scopeDir)
        .filter((d) => d === targetPkg)
        .map((d) => resolve(scopeDir, d))
    : [];
  if (targetPkgPath.length === 0) {
    throw new Error(
      `[build-lambdas] @duckdb/${targetPkg} not found in node_modules — npm ci on this machine resolved only other platforms. The analytics zips would crash on cold start; run npm ci so the ${LAMBDA_TARGET} binary is installed (its os/cpu gates must allow the deploy runner).`,
    );
  }

  for (const target of duckTargets) {
    const dist = resolve(distDir, target);
    await mkdir(dist, { recursive: true });
    await cp(duckApiSrc, join(dist, "node_modules", "@duckdb/node-api"), {
      recursive: true,
    });
    await cp(
      bindingsPkgSrc,
      join(dist, "node_modules", "@duckdb/node-bindings"),
      { recursive: true },
    );
    await cp(
      targetPkgPath[0],
      join(dist, "node_modules", `@duckdb/${targetPkg}`),
      { recursive: true },
    );
    for (const dep of bindingsDeps) {
      const src = findPkg(dep);
      if (!src) {
        throw new Error(
          `[build-lambdas] @duckdb/node-bindings runtime dependency '${dep}' not found in node_modules — the analytics zips would crash on cold start`,
        );
      }
      await cp(src, join(dist, "node_modules", dep), { recursive: true });
    }
    // The report bundle reads backend/src/analytics/reports/*.sql — copy them
    // next to index.mjs so the repo-tracked SQL ships in the zip.
    const reportsSrc = resolve(backendRoot, "src/analytics/reports");
    if (existsSync(reportsSrc)) {
      await cp(reportsSrc, join(dist, "reports"), { recursive: true });
    }
    console.log(
      `[build-lambdas] copied @duckdb/node-api + node-bindings + ${targetPkg} + [${bindingsDeps.join(", ")}]${target === "analytics-report" ? " + reports/*.sql" : ""} into dist/${target}/node_modules/`,
    );
  }
}

// Size gates: Lambda direct-upload caps the zip at 50 MB and unzipped contents
// at 250 MB. Fail the build near the limits (with margin) so a new dependency
// fails here instead of in a CI deploy.
const MAX_ZIP_MB = 45;
const MAX_UNZIPPED_MB = 240;
const sizeGateTargets = [...new Set([...sharpTargets, ...duckTargets])];
for (const target of sizeGateTargets) {
  const dist = resolve(distDir, target);
  const { totalBytes } = await walkSize(dist);
  const unzippedMb = totalBytes / (1024 * 1024);
  if (unzippedMb > MAX_UNZIPPED_MB) {
    throw new Error(
      `[build-lambdas] dist/${target} is ${unzippedMb.toFixed(0)} MB unzipped (limit ${MAX_UNZIPPED_MB}) — trim the bundle or move deploy to s3_object`,
    );
  }
  const { execFileSync } = await import("node:child_process");
  const zipBytes = execFileSync("zip", ["-qr", "-", "."], {
    cwd: dist,
    maxBuffer: 1024 * 1024 * 64,
  }).length;
  const zipMb = zipBytes / (1024 * 1024);
  if (zipMb > MAX_ZIP_MB) {
    throw new Error(
      `[build-lambdas] dist/${target} zips to ${zipMb.toFixed(0)} MB (limit ${MAX_ZIP_MB}) — trim the bundle or move deploy to s3_object`,
    );
  }
  console.log(
    `[build-lambdas] dist/${target}: ${unzippedMb.toFixed(0)} MB unzipped, ${zipMb.toFixed(0)} MB zipped (gates: ${MAX_UNZIPPED_MB}/${MAX_ZIP_MB})`,
  );
}

/**
 * @param {string} dir
 * @returns {Promise<{ totalBytes: number }>}
 */
async function walkSize(dir) {
  const { readdirSync, statSync } = await import("node:fs");
  let totalBytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, entry.name);
    if (entry.isDirectory()) totalBytes += (await walkSize(p)).totalBytes;
    else totalBytes += statSync(p).size;
  }
  return { totalBytes };
}
