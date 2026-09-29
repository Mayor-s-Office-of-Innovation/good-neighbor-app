// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite, startCheck } from "../helpers/app.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

/*
  Browser-back handling for transient states, end to end:

  - System back closes an open dialog without leaving the app or re-rendering
    the route behind it.
  - System back mid-embedded-capture (home hub capture phase in /today) plays
    the leaving-capture animation and returns to the home phase — same as the
    in-app cancel — instead of exiting the app.
  - Browser back after finishing a routed capture flow (/check, /problem)
    never revisits the finished screen (replace-at-completion).

  System back is driven the same way the site-admin spec drives it:
  page.evaluate(() => window.history.back()) — the same popstate path as
  hardware back / iOS swipe-back.
*/

test.describe("back button overlay handling", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page);
  });

  test("system back closes an open dialog and stays in the app", async ({
    page,
  }) => {
    await page.locator("#home-settings").click();
    await page.getByRole("menuitem", { name: "Attributions" }).click();
    const attributions = page.locator("#attributions-dialog");
    await expect(attributions).toBeVisible();
    await expect(page).toHaveURL(/\/today$/);

    // System back: the sentinel unwinds and the dialog closes; the app stays
    // on /today with the home phase intact.
    await page.evaluate(() => window.history.back());
    await expect(attributions).not.toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.locator("#start-check")).toBeVisible();
  });

  test("system back mid-embedded-capture returns to the home phase", async ({
    page,
  }) => {
    await startCheck(page);
    await expect(
      page.locator(".home--capture, .home--entering-capture"),
    ).toBeVisible();
    await expect(page.locator("#add-photo")).toBeVisible();

    // System back: the capture sentinel unwinds, the leave animation runs,
    // and the home phase (with the Start CTA) comes back — no app exit.
    await page.evaluate(() => window.history.back());
    await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/today$/);
    // The draft survives for later resume.
    await expect(
      page.getByRole("button", { name: /Resume a check/i }),
    ).toBeVisible();
  });

  test("browser back after finishing a routed flow never revisits it", async ({
    page,
  }) => {
    // Routed variant: /check is the standalone perimeter-check screen.
    await page.goto("/check");
    await expect(page.locator("#add-photo")).toBeVisible({ timeout: 30_000 });

    await page.locator("#file-input").setInputFiles(PHOTO_CLEAR, {
      timeout: 5_000,
    });
    await expect(page.locator(".shot img")).toHaveCount(1, {
      timeout: 30_000,
    });
    const done = page.locator("#done-check");
    await expect(done).toBeEnabled();
    await done.click();

    // Finish replaces the entry with /today…
    await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
    // …so the next back leaves the app (previous URL), never /check again.
    await page.evaluate(() => window.history.back());
    await expect(page.locator("#add-photo")).not.toBeVisible({
      timeout: 5_000,
    });
    await expect(page).not.toHaveURL(/\/check$/);
  });
});
