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
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
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
    // A cold Vite server (first load after npm install) optimizes dependencies
    // before the app renders, which can take over a minute on a slow machine.
    await page.goto("/", { timeout: 120_000 });
    const otp = page.locator("wa-otp-input#code-input");
    await otp.waitFor({ timeout: 120_000 });
    await otp.locator("#hidden-input").pressSequentially(siteCode);
    await page.locator("#continue").click();
    // Home, or the code-entry screen's own error (an exhausted or unknown code).
    const home = page.locator("#start-check");
    const codeError = page.locator("#code-error:not([hidden])");
    await Promise.race([
      home.waitFor({ timeout: 30_000 }),
      codeError.waitFor({ timeout: 30_000 }),
    ]);
    if (await codeError.isVisible()) {
      throw new Error(
        `the app rejected the code: "${(await codeError.innerText()).trim()}"`,
      );
    }
    // The binding must survive a reload before it is worth saving.
    await page.reload();
    await home.waitFor({ timeout: 30_000 });
    mkdirSync(dirname(stateFile), { recursive: true });
    // indexedDB: true captures the device binding; cookies/localStorage alone would not.
    await context.storageState({ path: stateFile, indexedDB: true });
  } catch (err) {
    console.error(
      `[a11y:local] binding failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
    );
    console.error(
      "  Seeded dev codes such as MOICHL allow three redemptions in total and each new browser profile is one.",
    );
    console.error(
      "  Fixes: a fresh code (A11Y_LOCAL_SITE_CODE=... npm run a11y:local -w e2e), or copy a working e2e/.a11y-local/state.json from another machine.",
    );
    process.exit(2);
  } finally {
    await browser.close();
  }
}

/**
 * Open a fresh context from the saved state, the way every ramp-check cell
 * will, and confirm it lands on the bound home screen. Exits with a
 * diagnosis otherwise, instead of letting every page time out.
 */
async function verifySavedState() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    storageState: stateFile,
  });
  const page = await context.newPage();
  try {
    await page.goto("/today", { timeout: 60_000 });
    await page.locator("#start-check").waitFor({ timeout: 30_000 });
    console.log(
      "[a11y:local] saved session restores: bound home screen reached",
    );
  } catch {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const origin = state.origins?.find((o) => o.origin === baseURL);
    const dbs = origin?.indexedDB?.length ?? 0;
    console.error(
      `[a11y:local] the saved session did not restore into a fresh browser context (landed on ${page.url()}).`,
    );
    console.error(
      `  ${stateFile}: ${origin ? "has" : "has no"} entry for ${baseURL}, ${dbs} IndexedDB database${dbs === 1 ? "" : "s"} saved.`,
    );
    console.error(
      "  Rerun with A11Y_LOCAL_REBIND=1 to bind again (spends one redemption of the code), or copy a working state.json from another machine.",
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
await verifySavedState();

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
