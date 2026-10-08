// @ts-check
import { test, expect } from "@playwright/test";
import { SITE_CODE, SITE_NAME } from "../helpers/fixtures.js";

test.describe("site setup", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("one tap on Continue dismisses the keyboard and submits the site code", async ({
    page,
  }) => {
    await page.goto("/");
    const otp = page.locator("wa-otp-input#code-input");
    await otp.locator("#hidden-input").pressSequentially(SITE_CODE);

    const continueButton = page.locator("#continue");
    await expect(continueButton).toBeEnabled();
    const box = await continueButton.boundingBox();
    if (!box) throw new Error("Continue button has no bounding box");
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.locator(".app__title")).toHaveText(SITE_NAME, {
      timeout: 30_000,
    });
  });
});
