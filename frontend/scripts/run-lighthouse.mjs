/*
  Run Lighthouse directly (no @lhci/cli) against the production build:

    1. rm -rf .lighthouseci/           (old reports)
    2. serve dist/ via `vite preview`  (replaces LHCI's staticDistDir server)
    3. run `lighthouse` 3x, writing lhr-<n>.json into .lighthouseci/
       (the lhr-*.json naming keeps scripts/print-lighthouse.mjs's filter
       intact; with --output=json, the CLI uses --output-path verbatim)
    4. kill the preview server

  Default settings (mobile emulation, throttling, all categories) match what
  LHCI ran. `--skip-audits=uses-http2` carries over from lighthouserc.json —
  it's a false positive on Vite preview and S3/CloudFront alike.

  Collection failures propagate (exit non-zero) — a failed run is a real
  error. Budget evaluation lives in print-lighthouse.mjs and stays warn-only.
*/
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const REPORT_DIR = join(ROOT, ".lighthouseci");
const PORT = 4173;
const URL_UNDER_TEST = `http://127.0.0.1:${PORT}/`;
const RUNS = 3;
const READY_TIMEOUT_MS = 15_000;

// Chrome can't write user-data to read-only or oddly-permissioned dirs in CI;
// a fresh temp profile per session avoids "Failed to create data directory"
// style crashes on github runners and local sandboxes alike.
const chromeDataDir = mkdtempSync(join(tmpdir(), "lighthouse-chrome-"));

rmSync(REPORT_DIR, { recursive: true, force: true });
mkdirSync(REPORT_DIR, { recursive: true });

const preview = spawn(
  "npx",
  [
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(PORT),
    "--strictPort",
  ],
  {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so the kill below takes its children too
  },
);
const previewLog = [];
preview.stdout.on("data", (c) => previewLog.push(c));
preview.stderr.on("data", (c) => previewLog.push(c));

const killPreview = () => {
  if (preview.pid != null) {
    try {
      process.kill(-preview.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
};
process.on("exit", killPreview);
process.on("SIGINT", () => {
  killPreview();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killPreview();
  process.exit(143);
});

/** Poll the preview server until it answers or the timeout elapses. */
async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(URL_UNDER_TEST, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `vite preview not reachable at ${URL_UNDER_TEST} after ${READY_TIMEOUT_MS / 1000}s. Log:\n${previewLog.join("")}`,
  );
}

await waitForServer();

for (let i = 1; i <= RUNS; i++) {
  const outPath = join(REPORT_DIR, `lhr-${i}.json`);
  execFileSync(
    "npx",
    [
      "lighthouse",
      URL_UNDER_TEST,
      `--output-path=${outPath}`,
      "--output=json",
      "--quiet",
      "--skip-audits=uses-http2",
      `--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage --user-data-dir=${chromeDataDir}`,
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
  console.log(`Run ${i}/${RUNS} complete.`);
}

killPreview();
console.log(
  `\n${RUNS} Lighthouse reports written to .lighthouseci/ — run 'npm run perf' for the summary table.`,
);
