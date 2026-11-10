import { test, expect, mockAdmin } from "./admin-mock.js";
import { fill } from "./providers-helpers.js";

/** @param {import("@playwright/test").Page} page */
const staffRows = (page) =>
  page.locator('[aria-labelledby="program-staff-title"]').getByRole("listitem");

test("?addStaff=1 opens the add-staff dialog and the new staff member appears", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  await page.goto("/programs/p1?addStaff=1&tab=staff");
  const dialog = page.locator("#add-program-staff-dialog");
  await expect(dialog).toBeVisible();
  const form = page.locator("#program-staff-form");
  await fill(form, "staff-first-name", "Riley");
  await fill(form, "staff-last-name", "New");
  await fill(form, "staff-phone", "4155550103");
  await fill(form, "staff-email", "riley@example.org");
  await form.locator("button[type='submit']").click();
  await expect(dialog).not.toBeVisible();
  await expect(staffRows(page).filter({ hasText: "Riley New" })).toBeVisible();
  expect(api.calls("POST", /users$/)[0].body).toEqual({
    firstName: "Riley",
    lastName: "New",
    phone: "4155550103",
    phoneExtension: "",
    email: "riley@example.org",
    siteManager: false,
  });
});
