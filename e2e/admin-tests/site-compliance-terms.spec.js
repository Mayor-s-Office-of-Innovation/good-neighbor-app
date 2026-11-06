import { test, expect, mockAdmin } from "./admin-mock.js";
import { complianceData, compliancePath } from "./site-compliance-helpers.js";

// Unit tests have no layout, so only a browser can place a click outside the card.
test("a reason explanation stays open on a click inside and closes on the backdrop", async ({
  page,
}) => {
  await mockAdmin(page, { data: complianceData({ active: true }) });
  await page.goto(compliancePath);
  const reasons = page.locator("#compliance-reasons-dialog");
  await page.locator("[data-compliance-reason='3']").first().click();
  await expect(reasons).toBeVisible();
  await reasons.locator("h2").click();
  await expect(reasons).toBeVisible();
  const { width, height } = page.viewportSize() || { width: 1280, height: 720 };
  // Each side of the card counts as backdrop.
  for (const [x, y] of [
    [2, height / 2],
    [width / 2, 2],
    [width - 2, height / 2],
    [width / 2, height - 2],
  ]) {
    if (!(await reasons.isVisible()))
      await page.locator("[data-compliance-reason='3']").first().click();
    await page.mouse.click(x, y);
    await expect(reasons).toBeHidden();
  }
});
