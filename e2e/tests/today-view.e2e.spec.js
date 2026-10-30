// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

/** Force the DOM replacement used when background home data changes.
 * @param {import("@playwright/test").Page} page
 */
async function refreshHome(page) {
  await page.locator("today-view").evaluate((element) => {
    const view = /** @type {any} */ (element);
    view._homeMarkup = null;
    view._renderHome(view._homeModel);
  });
}

test.describe("today view", () => {
  for (const width of [390, 1280]) {
    test(`home refresh preserves the open overflow menu and focus at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 891 });
      await bindSite(page);
      const trigger = page.locator("#home-action-menu-trigger");
      const menu = page.locator("#home-action-menu");
      const care = page.locator("#view-care-work");

      await trigger.click();
      await care.focus();
      await refreshHome(page);
      await expect(menu).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(care).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await refreshHome(page);
      await expect(menu).toBeHidden();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");

      await trigger.click();
      await refreshHome(page);
      await page.locator(".home-lead").click({ position: { x: 1, y: 1 } });
      await expect(menu).toBeHidden();
      await trigger.click();
      await care.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/care-work$/);
    });
  }

  for (const width of [390, 1280]) {
    test(`keeps the site selector beside Settings at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 891 });
      await bindSite(page);

      const header = page.locator(".home-top-actions");
      const selector = header.locator("site-switcher");
      await expect(selector).toBeVisible();
      await expect(header.locator("#home-settings")).toBeVisible();

      await expect
        .poll(() =>
          selector.evaluate((selector) => {
            const settings =
              selector.parentElement?.querySelector("#home-settings");
            if (!settings) return Infinity;
            const settingsBox = settings.getBoundingClientRect();
            const selectorBox = selector.getBoundingClientRect();
            if (selectorBox.right > settingsBox.left) return Infinity;
            return Math.abs(
              settingsBox.top +
                settingsBox.height / 2 -
                selectorBox.top -
                selectorBox.height / 2,
            );
          }),
        )
        .toBeLessThan(1);
    });
  }
});
