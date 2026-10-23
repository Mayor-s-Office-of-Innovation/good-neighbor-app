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
/** Device access-token lifetime (backend/src/lib/device-token.js ACCESS_TTL_SECONDS). */
const ACCESS_TOKEN_MINUTES = 15;

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
      "  Seeded dev codes allow three redemptions in total and each new browser profile is one.",
    );
    console.error(
      "  Ask an engineer for a fresh code and pass it: A11Y_LOCAL_SITE_CODE=... npm run a11y:local -w e2e",
    );
    process.exit(2);
  } finally {
    await browser.close();
  }
}

/**
 * Open a fresh context from the saved state, the way every ramp-check cell
 * will, confirm it lands on the bound home screen, then renew the session
 * and save the state back.
 *
 * Why renew every run: access tokens last 15 minutes and the refresh token
 * is single-use; a refresh invalidates every token issued before it. A
 * snapshot left as saved would go stale the first time any context had to
 * refresh. Renewing here, with the app's own modules (Vite serves them as
 * ES modules in dev), gives every cell a token good for the whole run and
 * leaves the file holding the only live refresh token.
 */
async function prepareSession() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    storageState: stateFile,
  });
  const page = await context.newPage();
  try {
    // Same allowance as bind(): a cold Vite server optimizes dependencies first.
    await page.goto("/today", { timeout: 120_000 });
    await page.locator("#start-check").waitFor({ timeout: 60_000 });
  } catch {
    // Only a visible code-entry screen means the credentials were rejected;
    // a page that never rendered is a slow server, not a reason to rebind.
    const atCodeEntry = await page
      .locator("wa-otp-input#code-input")
      .isVisible()
      .catch(() => false);
    if (!atCodeEntry) {
      console.error(
        `[a11y:local] the app did not render within the allowance (at ${page.url()}). The dev server may still be warming up; rerun. The saved session was not judged.`,
      );
      await browser.close();
      process.exit(2);
    }
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    const origin = state.origins?.find((o) => o.origin === baseURL);
    const dbs = origin?.indexedDB?.length ?? 0;
    console.error(
      `[a11y:local] the saved session did not restore: a fresh browser context landed on code entry.`,
    );
    console.error(
      `  ${stateFile}: ${origin ? "has" : "has no"} entry for ${baseURL}, ${dbs} IndexedDB database${dbs === 1 ? "" : "s"} saved.`,
    );
    console.error(
      "  Usually the session's refresh token was consumed by a run that did not save the renewed one (older runner), or the device was removed.",
    );
    console.error(
      "  Rerun with A11Y_LOCAL_REBIND=1 to bind again (spends one redemption of the code).",
    );
    await browser.close();
    process.exit(2);
  }
  try {
    const renewed = await page.evaluate(async () => {
      const db = await import("/src/db.js");
      const devices = await import("/src/services/devices.js");
      const site = await db.getSite();
      if (!site?.refreshToken)
        throw new Error("no refresh token in the stored site");
      const session = await devices.refreshDeviceToken(site.refreshToken);
      const stored = await db.updateSiteSession(session, site.siteId);
      if (!stored) throw new Error("site binding changed during refresh");
      return {
        generation: session.tokenGeneration,
        expiresIn: session.expiresIn,
      };
    });
    await context.storageState({ path: stateFile, indexedDB: true });
    console.log(
      `[a11y:local] saved session restores; renewed (generation ${renewed.generation}, good for ${Math.round(renewed.expiresIn / 60)} min) and saved`,
    );
  } catch (err) {
    console.error(
      `[a11y:local] could not renew the saved session: ${err instanceof Error ? err.message.split("\n")[0] : err}`,
    );
    console.error(
      "  Rerun with A11Y_LOCAL_REBIND=1 to bind again (spends one redemption of the code).",
    );
    process.exit(2);
  } finally {
    await browser.close();
  }
}

/**
 * The saved session only reaches ramp-check's browser contexts through its
 * `storageState` config option, which needs the ramp-check build pinned in
 * package.json. A stale install silently runs every page unbound, so check
 * the installed commit against the pin before anything else.
 */
function checkInstalledRampCheck() {
  const wanted = /ramp-check#([0-9a-f]{40})/.exec(
    JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"))
      .devDependencies["ramp-check"],
  )?.[1];
  const hiddenLock = resolve(here, "../node_modules/.package-lock.json");
  if (!wanted || !existsSync(hiddenLock)) return;
  const installed = /#([0-9a-f]{40})/.exec(
    JSON.parse(readFileSync(hiddenLock, "utf8")).packages?.[
      "node_modules/ramp-check"
    ]?.resolved ?? "",
  )?.[1];
  if (installed === wanted) return;
  console.error(
    `[a11y:local] installed ramp-check is ${installed?.slice(0, 7) ?? "unknown"}, e2e/package.json pins ${wanted.slice(0, 7)}. Run \`npm install\` at the repo root, then rerun.`,
  );
  process.exit(2);
}

checkInstalledRampCheck();
if (!(await serverUp())) {
  console.error(
    `[a11y:local] nothing answering at ${baseURL}. Start the app first: npm run dev:remote`,
  );
  process.exit(2);
}
if (process.env.A11Y_LOCAL_REBIND && existsSync(stateFile))
  unlinkSync(stateFile);
if (!existsSync(stateFile)) await bind();
await prepareSession();

// Every cell starts from the snapshot renewed above, and the app refreshes
// only when a request is refused, so nothing rotates while the access token
// lives. A scan that outlasts it would let one cell rotate the single-use
// refresh token behind the others' backs. The matrix takes about a minute;
// warn when a run gets anywhere near the limit so the matrix can be split.
const started = Date.now();
const run = spawnSync(
  "npx",
  ["ramp-check", "--config", resolve(here, "ramp-check.config.js")],
  {
    stdio: "inherit",
    cwd: here,
    shell: process.platform === "win32",
  },
);
const minutes = (Date.now() - started) / 60_000;
if (minutes > ACCESS_TOKEN_MINUTES * 0.7) {
  console.error(
    `[a11y:local] the scan took ${minutes.toFixed(1)} min; sessions last ${ACCESS_TOKEN_MINUTES}. Past that, later cells can lose their session. Narrow the matrix in ramp-check.config.js on this machine.`,
  );
}
if (run.status === 2) {
  console.error(
    "[a11y:local] ramp-check could not run. If pages failed to load after a code change, delete .a11y-local/state.json and rerun.",
  );
}
process.exitCode = run.status ?? 1;
