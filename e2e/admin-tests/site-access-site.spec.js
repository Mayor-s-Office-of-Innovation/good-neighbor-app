import { test, expect } from "./admin-mock.js";
import { accessData, mockManagers } from "./site-access-helpers.js";

import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
const accessSection = (page) =>
  // main.js hard-codes this aria-label, with no catalog key to look up.
  page.getByRole("region", { name: "App access" });

/** @param {import("@playwright/test").Page} page */
const removalDialog = (page) =>
  page.getByRole("dialog", { name: t("admin.devices.revokeTitle") });

// app-site-access.test.js covers Cancel and assigning Program staff.
test("assigning a person adds a Site manager membership", async ({ page }) => {
  const api = await mockManagers(page);
  await page.goto("/sites/s1");
  await page
    .locator("#manager-membership-form [data-manager-search] input")
    .fill("blair");
  await page.locator('[data-manager-option="u2"]').click();
  await page
    .locator('[data-manager-membership-actions] button[type="submit"]')
    .click();
  await expect
    .poll(() => api.calls("POST", /^sites\/s1\/manager-memberships$/).length)
    .toBe(1);
  expect(
    api.calls("POST", /^sites\/s1\/manager-memberships$/)[0].body,
  ).toMatchObject({ personId: "u2", email: "blair@example.org" });
});

test.describe("Site access tab", () => {
  // app-site-access.test.js checks the link mode and a failed delivery.
  test("emailing an enrollment code reports delivery", async ({ page }) => {
    const api = await mockManagers(page, { data: accessData() });
    // A new ID, as the backend issues, so the link must come from the reread list.
    api.on("POST", /^sites\/s1\/manager-grants$/, () => {
      const grants = /** @type {any[]} */ (api.data.grants);
      grants.push({ ...grants[0], grantId: "g9" });
      return {
        json: {
          grant: { grantId: "g9", deliveryStatus: "accepted" },
          enrollmentUrl: "https://example.org/enroll/code",
        },
      };
    });
    await page.goto("/sites/s1?section=access");
    await page
      .locator('[data-issue-manager-grant="m3"][data-delivery-mode="code"]')
      .click();
    await expect(page.locator("app-toasts")).toContainText(
      t("admin.enrollment.codeEmailed"),
    );
    await expect(
      page.locator(
        '[data-copy-enrollment-url="https://example.org/enroll/code"]',
      ),
    ).toHaveCount(1);
    expect(api.calls("POST", /manager-grants$/)[0].body).toEqual({
      membershipId: "m3",
      deliveryMode: "code",
    });
  });

  // Unit tests fake Escape with dialog.close(); only a browser sends the key.
  // device-revocation-dialog.test.js covers Cancel.
  test("Escape closes the removal dialog and removes nothing", async ({
    page,
  }) => {
    const api = await mockManagers(page, { data: accessData() });
    await page.goto("/sites/s1?section=access");
    const dialog = removalDialog(page);
    const remove = page.locator('[data-revoke-device="b1"]');
    await remove.click();
    await expect(dialog).toContainText(
      t("admin.devices.revokeDescription", {
        name: "Front desk phone",
        site: "Example Site",
      }),
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await api.expectNotSent("DELETE", /devices\//);
  });

  test("confirming the removal dialog removes the device", async ({ page }) => {
    const api = await mockManagers(page, { data: accessData() });
    await page.goto("/sites/s1?section=access");
    await page.locator('[data-revoke-device="b1"]').click();
    await removalDialog(page)
      .getByRole("button", { name: t("access.revoke") })
      .click();
    await expect(accessSection(page).getByRole("status")).toHaveText(
      t("admin.devices.revokedMessage", { name: "Front desk phone" }),
    );
    expect(api.calls("DELETE", /^sites\/s1\/devices\/b1$/)).toHaveLength(1);
  });
});
