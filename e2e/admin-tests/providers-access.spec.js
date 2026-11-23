import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { providerData } from "./providers-helpers.js";

const grants = /^providers\/v1\/manager-grants$/;

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} mode
 */
const issueButton = (page, mode) =>
  page.locator(
    `[data-issue-provider-manager-grant='m1'][data-delivery-mode='${mode}']`,
  );

// app-provider-access.test.js checks the code and failed-delivery toasts.
test("emailing a link invitation reports delivery accepted", async ({
  page,
}) => {
  const data = providerData();
  const api = await mockAdmin(page, { data });
  api.on("POST", grants, () => {
    data.providerGrants.unshift({
      grantId: "g9",
      providerId: "v1",
      issuedTo: "alex@example.org",
      deliveryMode: "link",
      status: "pending",
      deliveryStatus: "accepted",
    });
    return {
      json: {
        grant: { grantId: "g9", deliveryStatus: "accepted" },
        enrollmentUrl: "https://example.org/enroll/g9",
      },
    };
  });
  await page.goto("/providers/v1?section=access");
  await issueButton(page, "link").click();
  await expect(page.getByText(t("admin.enrollment.emailed"))).toBeVisible();
  await expect(
    page.locator("[data-copy-enrollment-url='https://example.org/enroll/g9']"),
  ).toHaveCount(1);
  expect(api.calls("POST", grants)[0].body).toEqual({
    membershipId: "m1",
    deliveryMode: "link",
  });
});
