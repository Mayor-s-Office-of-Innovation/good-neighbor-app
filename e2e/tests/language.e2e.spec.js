/*
  Language switching: the settings menu's Language item opens a picker; choosing
  a language persists per device, updates <html lang>, and survives reload.
  Catalogs for the non-English languages are English placeholders until the
  translations land, so this checks the wiring (document language, persistence,
  re-render) rather than translated copy.
*/
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";
import { t } from "../helpers/i18n.js";

test.describe("language switching", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page);
  });

  test("switches the document language from the settings menu and persists it", async ({
    page,
  }) => {
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

    await page.locator("#home-settings").click();
    await page
      .getByRole("menuitem", { name: t("today.settings.language") })
      .click();
    const dialog = page.locator("#language-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator('[data-locale="en"][aria-current="true"]'),
    ).toHaveCount(1);

    await dialog.locator('[data-locale="es"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
    // The home screen re-rendered in the new locale; the picker is closed.
    await expect(page.locator("#language-dialog[open]")).toHaveCount(0);
    await expect(page.locator("#home-settings")).toBeVisible();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-US");
    await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });

    await page.locator("#home-settings").click();
    await page
      .getByRole("menuitem", { name: t("today.settings.language") })
      .click();
    await expect(
      page.locator('#language-dialog [data-locale="es"][aria-current="true"]'),
    ).toHaveCount(1);
    await page.locator('#language-dialog [data-locale="en"]').click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  });
});
