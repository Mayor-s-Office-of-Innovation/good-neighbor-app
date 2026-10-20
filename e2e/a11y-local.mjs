// @ts-check
/*
  `npm run a11y:local -w e2e`: the designer's accessibility pass against the
  frontend-only dev server. Needs `npm run dev:remote` running in another
  terminal and Chromium installed once (`npx playwright install chromium`).

  1. Binds the site once through the real code-entry flow and saves the
     browser state (IndexedDB holds the binding) to .a11y-local/state.json.
     Every later run, and every matrix cell, starts from that file: setup
     codes allow three uses and expire, so binding per cell would burn them.
     Delete the file, or set A11Y_LOCAL_REBIND=1, to bind again.
  2. Runs ramp-check with ramp-check.config.js. Findings are expected, so
     the exit code is ramp-check's (1 on findings) but the point is
     ramp-check-report/: screenshots/ with every finding boxed and numbered,
     and ramp-check.md explaining each number.

  Site code: A11Y_LOCAL_SITE_CODE, default MOICHL (City Hall, the designer's
  site in dev per docs/quickstart-design.md).
*/
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const baseURL = process.env.A11Y_LOCAL_BASE_URL || "http://127.0.0.1:5173";
const siteCode = process.env.A11Y_LOCAL_SITE_CODE || "MOICHL";
const stateFile = resolve(here, ".a11y-local/state.json");

async function serverUp() {
  try {
    const res = await fetch(baseURL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function bind() {
  console.log(
    `[a11y:local] binding site ${siteCode} at ${baseURL} (saved to ${stateFile})`,
  );
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const otp = page.locator("wa-otp-input#code-input");
    await otp.waitFor();
    await otp.locator("#hidden-input").pressSequentially(siteCode);
    await page.locator("#continue").click();
    await page.locator("#start-check").waitFor({ timeout: 30_000 });
    mkdirSync(dirname(stateFile), { recursive: true });
    // indexedDB: true captures the device binding; cookies/localStorage alone would not.
    await context.storageState({ path: stateFile, indexedDB: true });
  } catch (err) {
    console.error(
      `[a11y:local] binding failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
    );
    console.error(
      "  Is the code right and unexpired? Codes allow three uses and last 72 hours; ask an engineer for a fresh one.",
    );
    process.exit(2);
  } finally {
    await browser.close();
  }
}

if (!(await serverUp())) {
  console.error(
    `[a11y:local] nothing answering at ${baseURL}. Start the app first: npm run dev:remote`,
  );
  process.exit(2);
}
if (process.env.A11Y_LOCAL_REBIND && existsSync(stateFile))
  unlinkSync(stateFile);
if (!existsSync(stateFile)) await bind();

const run = spawnSync(
  "npx",
  ["ramp-check", "--config", resolve(here, "ramp-check.config.js")],
  {
    stdio: "inherit",
    cwd: here,
    shell: process.platform === "win32",
  },
);
if (run.status === 2) {
  console.error(
    "[a11y:local] ramp-check could not run. If pages failed to load after a code change, delete .a11y-local/state.json and rerun.",
  );
}
process.exitCode = run.status ?? 1;
