// @ts-check
import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";
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
    const menu = page.getByRole("menu", { name: t("today.settings.aria") });
    await expect(menu.getByRole("menuitem")).toHaveText([
      t("today.settings.feedback"),
      t("today.settings.siteAdmin"),
      t("today.settings.language"),
      t("today.settings.attributions"),
      t("today.settings.logout"),
    ]);

    await menu
      .getByRole("menuitem", { name: t("today.settings.attributions") })
      .click();
    const attributions = page.locator("#attributions-dialog");
    await expect(attributions).toBeVisible();
    await expect(
      attributions.getByRole("link", {
        name: t("today.attributions.aws"),
      }),
    ).toBeVisible();
    await expect(
      attributions.getByRole("link", { name: t("today.attributions.census") }),
    ).toBeVisible();
    await attributions.getByRole("button", { name: t("common.close") }).click();

    await page.locator("#home-settings").click();
    await page
      .getByRole("menuitem", { name: t("today.settings.feedback") })
      .click();
    const feedback = page.locator("#feedback-dialog");
    await expect(feedback).toBeVisible();
    await feedback.getByRole("button", { name: t("common.cancel") }).click();

    await page.locator("#home-settings").click();
    await page
      .getByRole("menuitem", { name: t("today.settings.siteAdmin") })
      .click();
    await expect(page).toHaveURL(/\/site-admin$/);
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.siteDetails.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.contact.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.oversight.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: t("siteAdmin.compliance.title"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.perimeter.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: t("siteAdmin.letters.title"),
        exact: true,
      }),
    ).toBeVisible();

    const contactSection = page.locator(".site-admin-section", {
      has: page.getByRole("heading", { name: t("siteAdmin.contact.title") }),
    });
    await contactSection
      .getByRole("button", { name: t("common.edit") })
      .click();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.edit.contactTitle") }),
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
    await discard
      .getByRole("button", { name: t("common.keepEditing") })
      .click();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(lastName).toHaveValue("Unsaved change");

    await page.locator("[data-admin-back]").click();
    await discard
      .getByRole("button", { name: t("common.discardChanges") })
      .click();
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
      page.getByRole("heading", { name: t("siteAdmin.title") }),
    ).toHaveCount(0);
  });
});
