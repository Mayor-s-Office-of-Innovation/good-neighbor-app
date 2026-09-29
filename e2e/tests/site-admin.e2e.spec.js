// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test.describe("site admin access", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page);
  });

  test("settings entry points and routed admin views work end to end", async ({
    page,
  }) => {
    // Feedback now lives only in the settings menu; the old floating trigger
    // must not return.
    await expect(page.locator("#feedback-open")).toHaveCount(0);

    await page.locator("#home-settings").click();
    const menu = page.getByRole("menu", { name: "Settings" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Send feedback",
      "Site admin",
      "Attributions",
      "Logout",
    ]);

    await menu.getByRole("menuitem", { name: "Attributions" }).click();
    const attributions = page.locator("#attributions-dialog");
    await expect(attributions).toBeVisible();
    await expect(
      attributions.getByRole("link", {
        name: /Amazon Location Service data attribution/,
      }),
    ).toBeVisible();
    await expect(
      attributions.getByRole("link", { name: /U\.S\. Census Bureau Geocoder/ }),
    ).toBeVisible();
    await attributions.getByRole("button", { name: "Close" }).click();

    await page.locator("#home-settings").click();
    await page.getByRole("menuitem", { name: "Send feedback" }).click();
    const feedback = page.locator("#feedback-dialog");
    await expect(feedback).toBeVisible();
    await feedback.getByRole("button", { name: "Cancel" }).click();

    await page.locator("#home-settings").click();
    await page.getByRole("menuitem", { name: "Site admin" }).click();
    await expect(page).toHaveURL(/\/site-admin$/);
    await expect(
      page.getByRole("heading", { name: "Site information" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Site details" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Contact person" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Oversight" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Compliance", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Perimeter" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Compliance letters", exact: true }),
    ).toBeVisible();

    const contactSection = page.locator(".site-admin-section", {
      has: page.getByRole("heading", { name: "Contact person" }),
    });
    await contactSection.getByRole("button", { name: "Edit" }).click();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(
      page.getByRole("heading", { name: "Edit contact person" }),
    ).toBeVisible();
    await expect(page.locator("#site-admin-save")).toBeDisabled();

    // A routed edit view survives a reload and restores its server-backed
    // state instead of dropping back to the home or summary view.
    await page.reload();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(page.locator("#site-admin-save")).toBeDisabled();

    const lastName = page.locator("#admin-last-name input");
    await lastName.fill("Unsaved change");
    await expect(page.locator("#site-admin-save")).toBeEnabled();
    await page.evaluate(() => window.history.back());

    const discard = page.locator("#site-admin-discard-dialog");
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(lastName).toHaveValue("Unsaved change");

    await page.locator("[data-admin-back]").click();
    await discard.getByRole("button", { name: "Discard changes" }).click();
    await expect(page).toHaveURL(/\/site-admin$/);

    await page.locator("[data-admin-back]").click();
    await expect(page).toHaveURL(/\/today$/);
  });
});

test.describe("general site access", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page, {
      siteCode: "GUBMIS",
      siteName: "Mission District",
    });
  });

  test("does not expose or allow the site admin view", async ({ page }) => {
    await page.locator("#home-settings").click();
    await expect(page.locator("#settings-site-admin")).toHaveCount(0);

    await page.goto("/site-admin");
    await expect(page).toHaveURL(/\/today$/);
    await expect(
      page.getByRole("heading", { name: "Site information" }),
    ).toHaveCount(0);
  });
});
