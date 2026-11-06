import { test, expect } from "./admin-mock.js";
import { mockManagers } from "./site-access-helpers.js";

/** @param {import("@playwright/test").Page} page @param {string} name */
const field = (page, name) =>
  page.locator(`#site-manager-record-form wa-input[name="${name}"] input`);
/** @param {import("@playwright/test").Page} page */
const saveButton = (page) =>
  page.locator("#site-manager-record-form [data-save-button]");
/** @param {import("@playwright/test").Page} page @param {string} siteId */
const siteBox = (page, siteId) =>
  page.locator(`wa-checkbox[name="manager-site-id"][value="${siteId}"]`);

test("adding a manager creates the person and opens the new record", async ({
  page,
}) => {
  const api = await mockManagers(page);
  await page.goto("/managers/new");
  await field(page, "manager-first-name").fill("Riley");
  await field(page, "manager-last-name").fill("New");
  await field(page, "manager-phone").fill("4155550109");
  await field(page, "manager-email").fill("riley@example.org");
  await siteBox(page, "s3").click();
  await saveButton(page).click();
  await expect(page).toHaveURL(/\/managers\/person-4$/);
  await expect(page.locator("#manager-record-title")).toHaveText("Riley New");
  expect(api.calls("POST", /^people$/)[0].body).toMatchObject({
    firstName: "Riley",
  });
});

// app-site-managers.test.js covers an uncertain earlier write and a membership already gone.
test("saving a person manager updates the record and its Site assignments", async ({
  page,
}) => {
  const api = await mockManagers(page);
  await page.goto("/managers/u3");
  await field(page, "manager-first-name").fill("Morgana");
  await siteBox(page, "s3").click();
  await siteBox(page, "s1").click();
  await saveButton(page).click();
  await expect(page.locator("#manager-record-title")).toHaveText(
    "Morgana Person",
  );
  expect(api.calls("POST", /^sites\/s3\/manager-memberships$/)).toHaveLength(1);
  expect(
    api.calls("DELETE", /^sites\/s1\/manager-memberships\/m3$/),
  ).toHaveLength(1);
});
