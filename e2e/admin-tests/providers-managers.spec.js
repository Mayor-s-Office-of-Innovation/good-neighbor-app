import { test, expect, mockAdmin } from "./admin-mock.js";
import { providerData, fill } from "./providers-helpers.js";

const managers = /^providers\/v1\/manager-memberships$/;

test("a supervisor adds a provider manager from the dialog", async ({
  page,
}) => {
  const data = providerData();
  const api = await mockAdmin(page, { data });
  api.on("POST", managers, (request) => {
    const manager = {
      ...request.body,
      membershipId: "m9",
      providerId: "v1",
      name: `${request.body.firstName} ${request.body.lastName}`,
      status: "active",
    };
    data.providerManagers.push(manager);
    return { json: { manager } };
  });
  await page.goto("/providers/v1");
  // Only active managers are listed; the inactive one is history.
  await expect(page.locator("[data-provider-manager-row]")).toHaveCount(1);
  await page.locator("#add-provider-manager").click();
  const dialog = page.locator("#add-provider-manager-dialog");
  await expect(dialog).toBeVisible();
  const form = dialog.locator("form");
  await fill(form, "provider-manager-first-name", "Jordan");
  await fill(form, "provider-manager-last-name", "Sample");
  await fill(form, "provider-manager-email", "jordan@example.org");
  await fill(form, "provider-manager-phone", "4155550199");
  await form.locator("button[type='submit']").click();
  await expect(page.locator("[data-provider-manager-row]")).toHaveCount(2);
  expect(api.calls("POST", managers)[0].body).toEqual({
    firstName: "Jordan",
    lastName: "Sample",
    email: "jordan@example.org",
    phone: "4155550199",
    phoneExtension: "",
  });
});

test("the manager record saves edited names", async ({ page }) => {
  const data = providerData();
  const api = await mockAdmin(page, { data });
  api.on("PATCH", /manager-memberships\/m1$/, (request) => ({
    json: {
      manager: {
        ...request.body,
        membershipId: "m1",
        name: `${request.body.firstName} ${request.body.lastName}`,
        status: "active",
      },
    },
  }));
  await page.goto("/provider-managers/v1/m1");
  const form = page.locator("#provider-manager-record-form");
  await fill(form, "provider-manager-first-name", "Alexis");
  await form.locator("[data-save-button]").click();
  await expect(page.locator("admin-app h1")).toHaveText("Alexis Example");
  expect(api.calls("PATCH", /manager-memberships\/m1$/)[0].body).toEqual({
    firstName: "Alexis",
    lastName: "Example",
    email: "alex@example.org",
    phone: "4155550101",
    phoneExtension: "",
  });
});

test("a former manager is reinstated from their record", async ({ page }) => {
  const data = providerData();
  const api = await mockAdmin(page, { data });
  api.on("POST", /^providers\/v1\/manager-memberships\/m2\/reinstate$/, () => {
    const manager = data.providerManagers.find(
      (/** @type {any} */ item) => item.membershipId === "m2",
    );
    // The record redraws from a fresh read, so the stored manager must change.
    Object.assign(manager, { status: "active" });
    return { json: { manager: { ...manager } } };
  });
  await page.goto("/provider-managers/v1/m2");
  // A former manager has no transfer form.
  await expect(page.locator("[data-transfer-provider-manager]")).toHaveCount(0);
  await page.locator("[data-provider-manager-status='m2']").click();
  await expect(page.locator("[data-transfer-provider-manager]")).toBeVisible();
  expect(api.calls("POST", /m2\/reinstate$/)).toHaveLength(1);
});
