import { test, expect, mockAdmin, adminData } from "./admin-mock.js";

import { pickOption, openSite, typeInto } from "./site-record-helpers.js";
import { oversightPath } from "./site-compliance-helpers.js";

/** Site with one assigned City program manager and a custom system of care. */
function oversightData() {
  const data = adminData();
  data.sites[0] = {
    ...data.sites[0],
    oversight: {
      managingCityDepartment: "Example Department",
      managingSystemOfCare: "Custom System",
    },
  };
  /** @type {Record<string, any>[]} */
  const managers = [
    {
      ...data.programManagers[0],
      name: "Casey Manager",
      departmentName: "Example Department",
      accountStatus: "active",
    },
    {
      userId: "pm2",
      firstName: "Drew",
      lastName: "Lead",
      name: "Drew Lead",
      email: "drew@example.org",
      accountStatus: "invited",
      status: "active",
    },
  ];
  data.programManagers = /** @type {any} */ (managers);
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm1",
    type: "siteComplianceManagerAssignment",
    managerId: "pm1",
    status: "active",
  });
  return data;
}

/** @param {import("@playwright/test").Page} page */
const form = (page) => page.locator("#site-oversight-form");

test("oversight save sends the department and system of care", async ({
  page,
}) => {
  const api = await mockAdmin(page, { data: oversightData() });
  await openSite(page, oversightPath);
  await pickOption(page, "managing-system-of-care", "BHS-PBH");
  await form(page).locator("[data-save-button]").click();
  await expect.poll(() => api.calls("PATCH", /^sites\/s1$/).length).toBe(1);
  const [patch] = api.calls("PATCH", /^sites\/s1$/);
  expect(patch.body).toEqual({
    name: "Example Site",
    oversight: {
      managingCityDepartment: "Example Department",
      managingSystemOfCare: "BHS-PBH",
    },
  });
});

// A real wa-select's open and focus events save the choice that picking "add" puts back.
// app-site-oversight.test.js covers adding a system of care.
test("adding a new department selects it on the oversight form", async ({
  page,
}) => {
  const api = await mockAdmin(page, { data: oversightData() });
  api.on("POST", /^oversight-options$/, (request) => ({
    status: 201,
    json: {
      option: {
        type: "department",
        name: request.body.name,
        departmentId: "d9",
      },
    },
  }));
  await openSite(page, oversightPath);
  const department = page.locator(
    'admin-app wa-select[name="managing-city-department"]',
  );
  const dialog = page.locator("#new-oversight-option-dialog");
  await pickOption(page, "managing-city-department", "__add_department__");
  await expect(department).toHaveJSProperty("value", "Example Department");
  await dialog.locator("[data-close-dialog]").click();
  await expect(dialog).toBeHidden();
  await expect(department).toHaveJSProperty("value", "Example Department");
  await pickOption(page, "managing-city-department", "__add_department__");
  await expect(dialog).toBeVisible();
  await typeInto(page, "option-name", "Added Option");
  await dialog.locator("[data-save-button]").click();
  await expect(dialog).toBeHidden();
  await expect(department).toHaveJSProperty("value", "Added Option");
  expect(api.calls("POST", /^oversight-options$/)[0].body).toEqual({
    type: "department",
    name: "Added Option",
  });
});
