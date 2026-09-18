/*
  UI helpers for the Good Neighbor field app. Everything here drives the real
  user paths — site-code entry, the places gate, and the capture timeline —
  against the local harness (backend :3001 behind the Vite proxy on :5173).
*/
import { expect } from "@playwright/test";
import { SITE_CODE, SITE_NAME, PLACES } from "./fixtures.js";
import { typeDelay, isSlowMo } from "./pace.js";

/**
 * Bind a fresh browser context to the seeded site through the real code-entry
 * flow. Typing the code into the OTP field exercises the real input pipeline;
 * POST /site-code → POST /v1/devices then binds the device session.
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
  const bound = page.getByRole("heading", { name: SITE_NAME, exact: false });
  const save = page.locator("#save-places");
  await expect(save.or(bound)).toBeVisible({ timeout: 30_000 });
  if (await save.isVisible()) {
    // First-run gate: seeded places exist but placesConfiguredAt is unset.
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page).toHaveURL(/\/today$/);
  }
  await expect(page.locator("#start-check")).toBeVisible();
}

/**
 * Start a perimeter check and return the capture view.
 * @param {import("@playwright/test").Page} page
 */
export async function startCheck(page) {
  await page.locator("#start-check").click();
  const firstPlace = page.locator(".place-row__header").filter({
    hasText: PLACES[0],
  });
  await expect(firstPlace).toBeVisible();
  return firstPlace;
}

/**
 * Upload one photo into the currently expanded place.
 * The hidden `#file-input` sits inside <perimeter-check>'s light DOM.
 * @param {import("@playwright/test").Page} page
 * @param {string} filePath
 */
export async function addPhoto(page, filePath) {
  const addTile = page.locator("[data-add-photo]").first();
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
