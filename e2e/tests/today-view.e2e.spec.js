// @ts-check
import { test, expect } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test.describe("today view", () => {
  test("centers the site selector in the view", async ({ page }) => {
    await bindSite(page);

    const centers = await page.locator(".home-lead").evaluate((lead) => {
      const selector = lead.querySelector("site-switcher");
      if (!selector) throw new Error("Site selector is missing");
      const leadBox = lead.getBoundingClientRect();
      const selectorBox = selector.getBoundingClientRect();
      return {
        lead: leadBox.left + leadBox.width / 2,
        selector: selectorBox.left + selectorBox.width / 2,
      };
    });

    expect(Math.abs(centers.lead - centers.selector)).toBeLessThan(1);
  });
});
