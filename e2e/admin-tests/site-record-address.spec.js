import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { openSite } from "./site-record-helpers.js";

const suggestion = {
  label: "200 Sample Ave, San Francisco, CA 94110",
  addressParts: {
    streetNumber: "200",
    streetAddress: "Sample Ave",
    city: "San Francisco",
    state: "CA",
    zip: "94110",
  },
};

/** @param {import("@playwright/test").Page} page */
const query = (page) =>
  page.locator('admin-app wa-input[name="address-query"] input');
/** @param {import("@playwright/test").Page} page */
const results = (page) =>
  page.locator("admin-app [data-address-results] button");

test("a chosen suggestion fills the address and saves its parts", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  api.on("POST", /^address-suggestions$/, {
    json: {
      suggestions: [
        suggestion,
        { label: "201 Sample Ave, San Francisco, CA 94110" },
      ],
    },
  });
  await openSite(page);
  await page.locator("[data-edit-address]").click();
  await query(page).fill("200 Sample");
  await expect(results(page)).toHaveCount(2);
  await results(page).first().click();
  await expect(
    page.locator('admin-app wa-input[name="street-address"]'),
  ).toHaveJSProperty("value", "200 Sample Ave");
  await expect(page.locator('admin-app wa-input[name="zip"]')).toHaveJSProperty(
    "value",
    "94110",
  );
  await page.locator("[data-save-address]").click();
  await expect(page.getByText(t("admin.toast.addressSaved"))).toBeVisible();
  const [patch] = api.calls("PATCH", /^sites\/s1$/);
  expect(patch.body.addressParts).toEqual({
    streetNumber: "200",
    streetAddress: "Sample Ave",
    secondLine: "",
    city: "San Francisco",
    state: "CA",
    zip: "94110",
  });
});
