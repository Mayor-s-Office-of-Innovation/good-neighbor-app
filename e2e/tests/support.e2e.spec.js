import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";

test("Get help opens as a screen and Back returns home", async ({ page }) => {
  await page.locator("#home-settings").click();
  await expect(page.locator("#settings-help")).toHaveText(t("support.title"));
  await page.locator("#settings-help").click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.locator("support-view h1")).toHaveText(t("support.title"));
  await expect(page.locator("support-view dialog")).toHaveCount(0);
  await page.locator("support-view [data-back]").click();
  await expect(page.locator("today-view")).toBeVisible();
});
