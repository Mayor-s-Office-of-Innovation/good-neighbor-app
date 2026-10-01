// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test.describe("today view", () => {
  test("centers the site selector in the view", async ({ page }) => {
    await bindSite(page);

    const lead = page.locator(".home-lead");
    const selector = lead.locator("site-switcher");
    await expect(selector).toBeVisible();

    const centers = await lead.evaluate((element) => {
      const selector = element.querySelector("site-switcher");
      if (!selector) throw new Error("Site selector disappeared");
      const leadBox = element.getBoundingClientRect();
      const selectorBox = selector.getBoundingClientRect();
      return {
        lead: leadBox.left + leadBox.width / 2,
        selector: selectorBox.left + selectorBox.width / 2,
      };
    });

    expect(Math.abs(centers.lead - centers.selector)).toBeLessThan(1);
  });
});
