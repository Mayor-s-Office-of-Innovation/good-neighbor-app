import { test, expect, mockAdmin } from "./admin-mock.js";
import { providerData, fill } from "./providers-helpers.js";

test("creating a provider opens its record", async ({ page }) => {
  await mockAdmin(page, { data: providerData() });
  await page.goto("/providers/new");
  await fill(page.locator("#provider-form"), "provider-name", "New Provider");
  await page.locator("#provider-form button[type='submit']").click();
  await expect(page).toHaveURL(/\/providers\/new-provider$/);
  await expect(page.locator("#provider-title")).toHaveText("New Provider");
});

test("a supervisor renames a provider", async ({ page }) => {
  const api = await mockAdmin(page, { data: providerData() });
  await page.goto("/providers/v1");
  const form = page.locator("#provider-details-form");
  await fill(form, "provider-name", "Renamed Provider");
  await form.locator("[data-save-button]").click();
  await expect(page.locator("#provider-title")).toHaveText("Renamed Provider");
  expect(api.calls("PATCH", /^providers\/v1$/)[0].body).toEqual({
    name: "Renamed Provider",
  });
});
