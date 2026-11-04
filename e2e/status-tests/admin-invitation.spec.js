import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

const profile = {
  email: "alex@example.org",
  firstName: "Alex",
  lastName: "Example",
  phone: "415-555-0100",
  phoneExtension: "12",
  departmentId: "example",
  departmentName: "Example department",
};

test("invite an existing directory contact by email with keyboard review", async ({
  page,
}) => {
  /** @type {Record<string, unknown>[]} */
  const invitations = [];
  let lookups = 0;
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path.endsWith("/session"))
      json = {
        role: "compliance-supervisor",
        capabilities: { manageAdminUsers: true },
      };
    else if (path.endsWith("/oversight-options"))
      json = { departments: [], systemsOfCare: [] };
    else if (path.endsWith("/admin-users/lookup")) {
      lookups++;
      const target = route.request().postDataJSON().email;
      expect([
        profile.email,
        "new@example.org",
        "another@example.org",
        "third@example.org",
      ]).toContain(target);
      await new Promise((resolve) => setTimeout(resolve, 150));
      json = { profile: target === profile.email ? profile : null };
    } else if (
      path.endsWith("/admin-users") &&
      route.request().method() === "POST"
    ) {
      invitations.push(route.request().postDataJSON());
      json = {
        user: {
          username: profile.email,
          email: profile.email,
          role: "compliance-supervisor",
          lifecycleStatus: "invited",
        },
        invitationStatus: "invited",
      };
    } else json = { users: [], providers: [], programs: [], sites: [] };
    await route.fulfill({ json });
  });
  await page.goto("/administrators/new");
  const email = page.locator('wa-input[name="email"] input');
  await email.fill(profile.email);
  // Enter submits before the background lookup completes and before required details exist.
  await email.press("Enter");
  await expect(page).toHaveURL(/\/administrators$/);
  expect(lookups).toBe(1);
  expect(invitations).toHaveLength(1);
  expect(invitations[0]).toMatchObject({
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone,
    phoneExtension: profile.phoneExtension,
    departmentId: profile.departmentId,
  });

  await page.goto("/administrators/new");
  await page.locator('wa-input[name="email"] input').fill(profile.email);
  await page.keyboard.press("Tab");
  await expect(page.locator("[data-invitation-lookup-status]")).toHaveText(
    t("admin.users.lookupFound"),
  );
  await expect(page.locator('wa-input[name="firstName"] input')).toHaveValue(
    profile.firstName,
  );
  await expect(page.locator('wa-input[name="phone"] input')).toHaveValue(
    profile.phone,
  );
  await expect(
    page.locator('wa-input[name="phoneExtension"] input'),
  ).toBeVisible();
  await expect(page.locator('wa-select[name="departmentId"]')).toHaveJSProperty(
    "value",
    profile.departmentId,
  );
  const results = await new AxeBuilder({ page })
    .include("#admin-user-form")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  // An email change clears both the historical option and its selection.
  await email.fill("new@example.org");
  await email.press("Tab");
  await expect(page.locator("[data-invitation-lookup-status]")).toHaveText(
    t("admin.users.lookupNew"),
  );
  await expect(
    page.locator(`wa-option[value="${profile.departmentId}"]`),
  ).toHaveCount(0);
  await expect(page.locator('wa-select[name="departmentId"]')).toHaveJSProperty(
    "value",
    null,
  );
  await expect(page.locator("[data-phone-extension]")).toBeHidden();

  // Manual opening survives lookup start and resolution with a blank extension.
  await page.locator("[data-add-extension]").click();
  await email.fill("another@example.org");
  await expect(page.locator("[data-phone-extension]")).toBeVisible();
  await email.press("Tab");
  await expect(page.locator("[data-invitation-lookup-status]")).toHaveText(
    t("admin.users.lookupNew"),
  );
  await expect(
    page.locator('wa-input[name="phoneExtension"]'),
  ).toHaveJSProperty("value", "");
  await expect(page.locator("[data-phone-extension]")).toBeVisible();

  await page.locator("[data-remove-extension]").click();
  await email.fill("third@example.org");
  await email.press("Tab");
  await expect(page.locator("[data-invitation-lookup-status]")).toHaveText(
    t("admin.users.lookupNew"),
  );
  await expect(page.locator("[data-phone-extension]")).toBeHidden();
});
