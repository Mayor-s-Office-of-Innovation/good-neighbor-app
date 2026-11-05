import { test, expect, mockAdmin } from "./admin-mock.js";
import { setControl } from "./directory-helpers.js";

const created = { name: "New Example Site" };

/** @param {import("@playwright/test").Page} page */
async function fillRecord(page) {
  const form = page.locator("#new-site-record-form");
  await form.locator('wa-input[name="site-name"] input').fill(created.name);
  await setControl(form.locator('wa-select[name="site-type"]'), "shelter");
  await form.locator("[data-enter-address-manually]").click();
  await form
    .locator('wa-input[name="street-address"] input')
    .fill("200 Example Ave");
  await form.locator('wa-input[name="city"] input').fill("San Francisco");
  await form.locator('wa-input[name="state"] input').fill("CA");
  await form.locator('wa-input[name="zip"] input').fill("94103");
  await form
    .locator('wa-input[name="public-contact-email"] input')
    .fill("desk@example.org");
  await form
    .locator('wa-input[name="public-contact-phone"] input')
    .fill("4155550110");
  // Web Awesome updates validity after render; submitting earlier is refused.
  await expect
    .poll(() =>
      form.evaluate((element) =>
        /** @type {HTMLFormElement} */ (element).checkValidity(),
      ),
    )
    .toBe(true);
  return form;
}

test("creating a Site opens the new record, with managers assigned later", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  await page.goto("/sites/new?providerId=v1&programId=p1");
  const form = await fillRecord(page);
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/sites\/v1-new-example-site$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    created.name,
  );
  const [create] = api.calls("POST", /^providers\/v1\/sites$/);
  expect(create.body).toMatchObject({
    name: created.name,
    leadProgramId: "p1",
    siteType: "shelter",
    addressParts: { streetNumber: "200", streetAddress: "Example Ave" },
  });
  expect(create.body).not.toHaveProperty("primaryContactUserId");
  expect(api.calls("POST", /manager-memberships$/)).toHaveLength(0);
});
