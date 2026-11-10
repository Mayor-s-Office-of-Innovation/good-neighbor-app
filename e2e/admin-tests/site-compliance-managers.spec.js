import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { complianceData, oversightPath } from "./site-compliance-helpers.js";
import { setControl } from "./directory-helpers.js";

const list = "[data-compliance-manager-list]";
const inviteDialog = "#new-city-program-manager-dialog";

/** One assigned manager who still needs an invite, plus two to choose from. */
function managersData() {
  const data = complianceData();
  data.programManagers = [
    {
      userId: "pm1",
      name: "Casey Manager",
      firstName: "Casey",
      lastName: "Manager",
      email: "casey@example.org",
      accountStatus: "not-invited",
      status: "active",
    },
    {
      userId: "pm2",
      name: "Jordan Lead",
      email: "jordan@example.org",
      departmentName: "Example Department",
      accountStatus: "active",
      status: "active",
    },
    {
      userId: "pm3",
      name: "Riley Pending",
      email: "riley@example.org",
      accountStatus: "invited",
      status: "active",
    },
  ];
  data.siteItems.s1.push({
    sk: "COMPLIANCE_MANAGER#pm1",
    type: "siteComplianceManagerAssignment",
    managerId: "pm1",
    status: "active",
  });
  return data;
}

/**
 * Fill and send the new-manager invite form.
 * @param {import("@playwright/test").Page} page
 * @param {string} email
 */
async function fillInvite(page, email) {
  const dialog = page.locator(inviteDialog);
  await setControl(
    dialog.locator("wa-input[name='manager-first-name']"),
    "Sam",
  );
  await setControl(
    dialog.locator("wa-input[name='manager-last-name']"),
    "Example",
  );
  await setControl(dialog.locator("wa-input[name='manager-email']"), email);
  await setControl(
    dialog.locator("wa-input[name='manager-phone']"),
    "4155550199",
  );
  await setControl(
    dialog.locator("wa-select[name='manager-department']"),
    "d1",
  );
  await page.locator(`${inviteDialog} [data-save-button]`).click();
}

// app-site-compliance-managers.test.js checks the two-manager limit and its errors.
test("a new manager is invited from the Site and selected", async ({
  page,
}) => {
  const data = managersData();
  const api = await mockAdmin(page, { data });
  api.on("POST", /^admin-users$/, (request) => {
    data.programManagers.push({
      userId: "new-1",
      name: `${request.body.firstName} ${request.body.lastName}`,
      email: request.body.email,
      accountStatus: "invited",
      status: "invited",
    });
    return { json: { invitationStatus: "invited", user: {} } };
  });
  await page.goto(oversightPath);
  await page.locator("#add-compliance-manager").click();
  await page.locator("#invite-new-compliance-manager").click();
  await expect(page.locator(inviteDialog)).toBeVisible();
  await fillInvite(page, "sam.one@example.org");
  await expect(page.locator(inviteDialog)).toBeHidden();
  await expect(page.locator("app-toasts")).toContainText(
    t("admin.toast.invitationSent"),
  );
  await expect(page.locator(`${list} > li`)).toHaveCount(2);
  expect(api.calls("POST", /^admin-users$/)[0].body).toMatchObject({
    email: "sam.one@example.org",
    departmentId: "d1",
    departmentName: "Example Department",
  });
});
