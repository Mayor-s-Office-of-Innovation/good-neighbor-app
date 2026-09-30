// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

/*
  Browser-back handling, end to end (routed-capture model):

  - Home CTAs navigate to real URLs (/check, /problem); system back from a
    capture screen is a normal route pop back to /today, with the draft kept
    for resume.
  - System back closes an open dialog (its #dialog hash sentinel) without
    leaving the app.
  - A refresh mid-dialog re-lands on the route WITHOUT re-opening the dialog
    (hash is live-only; decision/informational state is not resurrected).
  - Browser back after finishing a capture flow never revisits the finished
    screen (replace-at-completion).

  System back is driven the same way the site-admin spec drives it:
  page.evaluate(() => window.history.back()) — the same popstate path as
  hardware back / iOS swipe-back.
*/

test.describe("back button handling", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page);
  });

  test("home CTA navigates to /check; back returns home with draft kept", async ({
    page,
  }) => {
    await page.locator("#start-check").click();

    // Routed capture: real URL, standalone screen.
    await expect(page).toHaveURL(/\/check$/);
    await expect(page.locator("#add-photo")).toBeVisible({ timeout: 30_000 });

    // System back: a normal route pop to home.
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });
    // The draft survives for later resume.
    await expect(
      page.getByRole("button", { name: /Resume a check/i }),
    ).toBeVisible();
  });

  test("system back closes an open dialog and strips its #hash", async ({
    page,
  }) => {
    await page.locator("#home-settings").click();
    await page.getByRole("menuitem", { name: "Attributions" }).click();
    const attributions = page.locator("#attributions-dialog");
    await expect(attributions).toBeVisible();
    // The dialog sub-state is visible in the URL as a short-lived hash.
    await expect(page).toHaveURL(/\/today#attributions$/);

    // System back: the sentinel unwinds, the dialog closes, the hash is gone.
    await page.evaluate(() => window.history.back());
    await expect(attributions).not.toBeVisible({ timeout: 5_000 });
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.locator("#start-check")).toBeVisible();
  });

  test("refresh mid-dialog does not re-open the dialog", async ({ page }) => {
    await page.locator("#home-settings").click();
    await page.getByRole("menuitem", { name: "Attributions" }).click();
    await expect(page.locator("#attributions-dialog")).toBeVisible();

    await page.reload();

    // The view restores from the URL; the dialog state is live-only and
    // stays closed — no decision or sheet is resurrected by a refresh.
    await expect(page.locator("#attributions-dialog")).not.toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator("#start-check")).toBeVisible();
    await expect(page).toHaveURL(/\/today$/);
  });

  test("browser back after finishing a routed flow never revisits it", async ({
    page,
  }) => {
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
