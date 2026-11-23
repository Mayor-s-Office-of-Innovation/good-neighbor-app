import { test, expect, mockAdmin } from "./admin-mock.js";

import { providerData, fill } from "./providers-helpers.js";

test("a Program created from a provider returns to that provider", async ({
  page,
}) => {
  const api = await mockAdmin(page, { data: providerData() });
  await page.goto("/programs/new?returnTo=provider&providerId=v1");
  await expect(
    page.locator("#program-form [name='program-staff']"),
  ).toHaveCount(0);
  await fill(page.locator("#program-form"), "program-name", "Provider Program");
  await page.locator("#program-form button[type='submit']").click();
  await expect(page).toHaveURL(/\/providers\/v1$/);
  expect(api.calls("POST", /^programs$/)[0].body).toEqual({
    name: "Provider Program",
    providerId: "v1",
  });
});
