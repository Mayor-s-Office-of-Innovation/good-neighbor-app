import { test, expect, mockAdmin } from "./admin-mock.js";

import { typeInto, openSite } from "./site-record-helpers.js";

/** @param {import("@playwright/test").Page} page */
const leaveDialog = (page) => page.locator("#site-unsaved-dialog");

test("browser Back with unsaved edits keeps the Site open until discarded", async ({
  page,
}) => {
  await mockAdmin(page);
  await page.goto("/sites");
  await page.locator('admin-app a[href="/sites/s1"]').first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Example Site",
  );
  await typeInto(page, "site-name", "Example Site Renamed");
  await page.goBack();
  await expect(leaveDialog(page)).toBeVisible();
  await expect(page).toHaveURL(/\/sites\/s1$/);
  await leaveDialog(page).locator('button[value="discard"]').click();
  await expect(page).toHaveURL(/\/sites$/);
  await expect(page.locator("#site-details-form")).toHaveCount(0);
});

test("closing the tab with unsaved edits asks the browser to confirm", async ({
  page,
}) => {
  await mockAdmin(page);
  await openSite(page);
  // A clean form lets the page unload without a prompt.
  const cleanPrompt = await page.evaluate(() => {
    const event = new window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cleanPrompt).toBe(false);
  await typeInto(page, "site-name", "Example Site Renamed");
  const prompt = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const dialog = await prompt;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
});
