// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test.describe("today view", () => {
  test("centers the site selector in the view", async ({ page }) => {
    await bindSite(page);

    const lead = page.locator(".home-lead");
    const selector = lead.locator("site-switcher");
    await expect(selector).toBeVisible();

    await expect
      .poll(() =>
        selector.evaluate((selector) => {
          const element = selector.closest(".home-lead");
          if (!element) return Infinity;
          const leadBox = element.getBoundingClientRect();
          const selectorBox = selector.getBoundingClientRect();
          return Math.abs(
            leadBox.left +
              leadBox.width / 2 -
              selectorBox.left -
              selectorBox.width / 2,
          );
        }),
      )
      .toBeLessThan(1);
  });
});
