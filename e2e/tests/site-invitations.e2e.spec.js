import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

/** Mount the real access view against synthetic API responses, with no live data.
 * @param {import('@playwright/test').Page} page @param {boolean} provider
 */
async function accessView(page, provider) {
  await page.route("**/invitation-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en" class="wa-dark wa-theme-default wa-palette-default wa-brand-blue"><head><title>Invitation test</title><link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/styles/base.css"></head><body></body></html>',
    }),
  );
  await page.route("**/app/v1/manager/device-bindings", (route) =>
    route.fulfill({ json: { bindings: [] } }),
  );
  await page.route("**/app/v1/manager/staff-grants/current", (route) =>
    route.fulfill({ json: { canInviteManagers: provider, grants: [] } }),
  );
  await page.goto("/invitation-test");
  await page.evaluate(async (provider) => {
    const mainUrl = "/src/main.js";
    await import(mainUrl);
    const dbUrl = "/src/db.js";
    const componentUrl = "/src/components/site-admin.js";
    const { setSite } = await import(dbUrl);
    await setSite("Test site", {
      siteId: "site-1",
      deviceId: "issuer",
      accessLevel: "manager",
      token: "synthetic-access",
      refreshToken: "synthetic-refresh",
      tokenExpiresAt: "2099-01-01T00:00:00Z",
    });
    await import(componentUrl);
    if (provider) {
      const rolesUrl = "/src/components/site-access-roles.js";
      await import(rolesUrl);
    }
    document.body.append(document.createElement("site-access-view"));
  }, provider);
  await expect(page.locator("#staff-device-label")).toBeVisible();
}

test("provider chooses an exclusive role by keyboard and supplies manager contact details", async ({
  page,
}) => {
  await page.setViewportSize({ width: 626, height: 988 });
  await accessView(page, true);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: t("access.siteHeading", { site: "Test site" }),
    }),
  ).toBeVisible();
  await expect(page.locator("#invitation-role")).toHaveAttribute(
    "label",
    t("access.invitationRole"),
  );
  const form = page.locator("#staff-grant-form");
  const create = form.locator('button[type="submit"]');
  await expect(create).toBeDisabled();
  await page.locator("#staff-device-label input").fill("New phone");
  await expect(create).toBeDisabled();
  const manager = page.getByRole("radio", {
    name: t("access.role.manager"),
    exact: true,
  });
  const team = page.getByRole("radio", {
    name: t("access.role.general"),
    exact: true,
  });
  await manager.focus();
  await page.keyboard.press("Space");
  await expect(manager).toBeChecked();
  await expect(team).not.toBeChecked();
  await expect(page.locator("#invitation-manager-contact")).toBeVisible();
  await expect(create).toBeDisabled();
  await page.locator("#invitation-first-name input").fill("New");
  await expect(create).toBeDisabled();
  await page.locator("#invitation-last-name input").fill("Manager");
  const lastNameBox = await page.locator("#invitation-last-name").boundingBox();
  const emailBox = await page.locator("#invitation-email").boundingBox();
  if (!lastNameBox || !emailBox)
    throw new Error("Manager contact fields are not visible");
  expect(
    emailBox.y - (lastNameBox.y + lastNameBox.height),
  ).toBeGreaterThanOrEqual(12);
  await page.locator("#invitation-email input").fill("new@example.org");
  await expect(create).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath("manager-invitation.png"),
    fullPage: true,
  });
  const audit = await new AxeBuilder({ page })
    .include("#staff-grant-form")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  await manager.focus();
  await page.keyboard.press("ArrowDown");
  await expect(team).toBeChecked();
  await expect(manager).not.toBeChecked();
  await expect(page.locator("#invitation-manager-contact")).toBeHidden();
  await expect(create).toBeEnabled();
  // Return to manager and verify the submitted role/contact contract.
  await team.focus();
  await page.keyboard.press("ArrowUp");
  /** @type {Record<string, unknown> | undefined} */
  let body;
  await page.route("**/app/v1/manager/staff-grants", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: {
        grant: {
          grantId: "synthetic-grant",
          label: "New phone",
          accessLevel: "manager",
          status: "pending",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    });
  });
  await create.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => body)
    .toEqual({
      label: "New phone",
      accessLevel: "manager",
      firstName: "New",
      lastName: "Manager",
      email: "new@example.org",
    });
  await expect(page.locator('[data-grant-id="synthetic-grant"]')).toBeVisible();
});

test("site managers keep the existing team invitation form and request", async ({
  page,
}) => {
  await accessView(page, false);
  await expect(page.locator("#invitation-role")).toHaveCount(0);
  await page.locator("#staff-device-label input").fill("Team phone");
  /** @type {Record<string, unknown> | undefined} */
  let body;
  await page.route("**/app/v1/manager/staff-grants", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: {
        grant: {
          grantId: "team-grant",
          label: "Team phone",
          accessLevel: "general",
          status: "pending",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    });
  });
  await page.locator('#staff-grant-form button[type="submit"]').click();
  await expect.poll(() => body).toEqual({ label: "Team phone" });
});

test("redemption refreshes both device roles without clearing an invitation draft", async ({
  page,
}) => {
  await accessView(page, true);
  await page.locator("#staff-device-label input").fill("Keep this draft");
  await page.route("**/app/v1/manager/device-bindings", (route) =>
    route.fulfill({
      json: {
        bindings: [
          {
            bindingId: "manager",
            label: "Manager phone",
            accessLevel: "manager",
            status: "active",
          },
          {
            bindingId: "general",
            label: "Team phone",
            accessLevel: "general",
            status: "active",
          },
        ],
      },
    }),
  );
  await page.evaluate(async () => {
    const view = /** @type {any} */ (
      document.querySelector("site-access-view")
    );
    view._grants = [{ grantId: "redeemed", expiresAt: "2099-01-01T00:00:00Z" }];
    await view._refreshGrants();
  });
  const manager = page
    .locator(".site-access-device")
    .filter({ hasText: "Manager phone" });
  const team = page
    .locator(".site-access-device")
    .filter({ hasText: "Team phone" });
  await expect(manager).toContainText(t("access.role.manager"));
  await expect(team).toContainText(t("access.role.general"));
  await expect(manager.locator("[data-revoke-team-device]")).toHaveCount(1);
  await expect(team.locator("[data-revoke-team-device]")).toHaveCount(1);
  await expect(page.locator("#staff-device-label input")).toHaveValue(
    "Keep this draft",
  );
});

test("site managers cannot revoke manager devices", async ({ page }) => {
  await accessView(page, false);
  await page.route("**/app/v1/manager/device-bindings", (route) =>
    route.fulfill({
      json: {
        bindings: [
          {
            bindingId: "manager",
            label: "Manager phone",
            accessLevel: "manager",
            status: "active",
          },
          {
            bindingId: "team",
            label: "Team phone",
            accessLevel: "general",
            status: "active",
          },
        ],
      },
    }),
  );
  await page.evaluate(async () => {
    const view = /** @type {any} */ (
      document.querySelector("site-access-view")
    );
    await view._deviceView.refreshDevices(view);
  });
  await expect(
    page
      .locator(".site-access-device")
      .filter({ hasText: "Manager phone" })
      .locator("button"),
  ).toHaveCount(0);
  await expect(
    page
      .locator(".site-access-device")
      .filter({ hasText: "Team phone" })
      .locator("button"),
  ).toHaveCount(1);
});

test("capability refresh disables manager actions without downgrading or clearing the draft", async ({
  page,
}) => {
  await accessView(page, true);
  await page.locator("#staff-device-label input").fill("Draft phone");
  await page.locator('wa-radio[value="manager"]').click();
  await page.locator("#invitation-first-name input").fill("Jane");
  await page.locator("#invitation-last-name input").fill("Smith");
  await page.locator("#invitation-email input").fill("jane@example.org");
  const create = page.locator('#staff-grant-form button[type="submit"]');
  await expect(create).toBeEnabled();
  await page.route("**/app/v1/manager/staff-grants/current", (route) =>
    route.fulfill({
      json: { canInviteManagers: false, canManageAccess: false, grants: [] },
    }),
  );
  await page.evaluate(async () => {
    const view = /** @type {any} */ (
      document.querySelector("site-access-view")
    );
    await view._refreshGrants();
  });
  await expect(create).toBeDisabled();
  await expect(page.locator("#staff-device-label input")).toHaveValue(
    "Draft phone",
  );
  await expect(page.locator("#invitation-email input")).toHaveValue(
    "jane@example.org",
  );
  expect(
    await page
      .locator("#invitation-role")
      .evaluate((el) => /** @type {any} */ (el).value),
  ).toBe("manager");
  await expect(page.locator("#invitation-manager-contact")).toBeVisible();
  await page.route("**/app/v1/manager/staff-grants/current", (route) =>
    route.fulfill({
      json: { canInviteManagers: true, canManageAccess: true, grants: [] },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(create).toBeEnabled();
  await expect(page.locator("#invitation-email input")).toHaveValue(
    "jane@example.org",
  );
  await page.route("**/app/v1/manager/staff-grants", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "manager_email_already_assigned" },
    }),
  );
  await create.click();
  await expect(page.locator("#staff-grant-error")).toHaveText(
    t("access.duplicateEmail"),
  );
  await expect(page.locator("#invitation-email input")).toHaveValue(
    "jane@example.org",
  );
});

test("capability polling continues when no invitations remain", async ({
  page,
}) => {
  await accessView(page, true);
  await page.locator('wa-radio[value="manager"]').click();
  let reads = 0;
  await page.route("**/app/v1/manager/staff-grants/current", (route) => {
    reads++;
    return route.fulfill({
      json: { canInviteManagers: false, canManageAccess: false, grants: [] },
    });
  });
  await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThan(0);
  await expect(page.locator("#staff-device-label input")).toBeDisabled();
});
