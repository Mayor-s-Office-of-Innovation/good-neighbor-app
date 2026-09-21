/*
  UI helpers for the Good Neighbor field app. Everything here drives the real
  user paths — site-code entry, the flat photo roll capture screen, and the
  home results tray — against the local harness (backend :3001 behind the Vite
  proxy on :5173).
*/
import { expect } from "@playwright/test";
import { SITE_CODE, SITE_NAME } from "./fixtures.js";
import { typeDelay, isSlowMo } from "./pace.js";

/**
 * Bind a fresh browser context to the seeded site through the real code-entry
 * flow. Typing the code into the OTP field exercises the real input pipeline;
 * POST /site-code → POST /v1/devices then binds the device session and the
 * app lands on /today (there is no places gate any more).
 * @param {import("@playwright/test").Page} page
 */
export async function bindSite(page) {
  await page.goto("/");
  const otp = page.locator("wa-otp-input#code-input");
  await expect(otp).toBeVisible();
  // wa-otp-input renders a real text input in its shadow root; Playwright CSS
  // pierces it. Typing exercises the component's own input pipeline (paste and
  // fill also work, but typing is closest to a real device).
  await otp.locator("#hidden-input").pressSequentially(SITE_CODE, {
    ...(typeDelay > 0 ? { delay: typeDelay } : {}),
  });
  await page.locator("#continue").click();
  await expect(
    page.getByRole("heading", { name: SITE_NAME, exact: false }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#start-check")).toBeVisible();
}

/**
 * Start a perimeter check and return the photo roll's add-photo tile, which
 * is the first thing the capture view renders.
 * @param {import("@playwright/test").Page} page
 */
export async function startCheck(page) {
  await page.locator("#start-check").click();
  const addTile = page.locator("#add-photo");
  await expect(addTile).toBeVisible();
  return addTile;
}

/**
 * Upload one photo into the photo roll.
 * The hidden `#file-input` sits inside <perimeter-check>'s light DOM.
 * @param {import("@playwright/test").Page} page
 * @param {string} filePath
 */
export async function addPhoto(page, filePath) {
  const addTile = page.locator("#add-photo");
  await expect(addTile).toBeVisible();
  if (isSlowMo) {
    // In slow-mo, make the tap visible without triggering the real camera
    // handoff (the tile click opens the native file picker; Playwright
    // intercepts file choosers only with a listener, so clicking would hang
    // headed runs). A brief highlight + pause stands in for "the user tapped".
    await addTile
      .evaluate((el) => el.classList.add("e2e-tap-flash"))
      .catch(() => {});
    await page.waitForTimeout(typeDelay * 4 || 800);
    await addTile
      .evaluate((el) => el.classList.remove("e2e-tap-flash"))
      .catch(() => {});
  }
  await page.locator("#file-input").setInputFiles(filePath, { timeout: 5_000 });
}

/**
 * Finish the check from the capture screen and wait for home.
 * Finish carries `disabled` until the completion rule is met (five photos or
 * one description), so callers assert on that before calling this.
 * @param {import("@playwright/test").Page} page
 */
export async function finishCheck(page) {
  const done = page.locator("#done-check");
  await expect(done).toBeEnabled();
  await done.click();
  await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });
}

/**
 * The home tray that holds only THIS check's fresh cards. GET /v1/tasks also
 * returns older persisted tasks from previous runs (DDB Local keeps state),
 * which render in a separate section.
 * @param {import("@playwright/test").Page} page
 */
export function newResultsTray(page) {
  return page.locator('section[aria-label="New analysis results"]');
}

/**
 * Dismiss every generated card in the NEW results tray via its trash button.
 * Delete flow: trash (data-analysis-action="delete") → confirm dialog →
 * rejectAnalysisCondition → the card hides behind a 5s undo toast, and the
 * tray re-renders. Always drive the FIRST remaining card; when the last card's
 * deletion lands, the empty tray renders its "resolved or deleted" placeholder,
 * so expect the section to lose its cards. Waits for at least one card first
 * (the tray can re-render as evidence hydrates) and returns how many it saw.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<number>}
 */
export async function dismissAllNewResults(page) {
  const cards = newResultsTray(page).locator(".analysis-card");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  const cardCount = await cards.count();
  for (let remaining = cardCount; remaining > 0; remaining -= 1) {
    await cards.first().locator('[data-analysis-action="delete"]').click();
    await page.locator("#analysis-delete-confirm").click();
    await expect(cards).toHaveCount(remaining - 1, { timeout: 30_000 });
  }
  await expect(cards).toHaveCount(0);
  return cardCount;
}
