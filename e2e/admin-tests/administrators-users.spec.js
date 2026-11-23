import { test, expect, mockAdmin, settle } from "./admin-mock.js";
import { setControl } from "./directory-helpers.js";
import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
async function fillInvite(page) {
  const form = page.locator("#admin-user-form");
  await form.locator('wa-input[name="firstName"] input').fill("Ivy");
  await form.locator('wa-input[name="lastName"] input').fill("Invitee");
  await form.locator('wa-input[name="email"] input').fill("ivy@example.org");
  await form.locator('wa-input[name="phone"] input').fill("4155550120");
  await setControl(form.locator('wa-select[name="departmentId"]'), "d1");
  return form;
}

test("inviting a user returns to the list with the new account", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  api.on("POST", /^admin-users$/, (request) => ({
    json: {
      user: {
        username: "ivy",
        name: "Ivy Invitee",
        email: request.body.email,
        role: request.body.role,
        lifecycleStatus: "invited",
      },
      invitationStatus: "invited",
    },
  }));
  await page.goto("/administrators");
  await page.locator('[data-navigate="/administrators/new"]').click();
  await expect(page.locator("#new-admin-user-title")).toBeVisible();
  const form = await fillInvite(page);
  await form.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/administrators$/);
  await expect(page.locator("table")).toContainText("ivy@example.org");
  await expect(page.locator("app-toasts")).toContainText(
    t("admin.toast.invitationSent"),
  );
  expect(api.calls("POST", /^admin-users$/)[0].body).toMatchObject({
    firstName: "Ivy",
    departmentId: "d1",
    role: "compliance-manager",
  });
  // The list redraws from the invite reply, not a second read.
  await settle(page);
  expect(api.calls("GET", /^admin-users$/)).toHaveLength(1);
});

test("the profile saves changed names and shows the result", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  // The server tidies the name, so the form must redraw from its reply.
  api.on("PUT", /^profile$/, (request) => {
    const reply = api.reply(request);
    reply.json.profile.firstName = "Casey-Jo";
    return reply;
  });
  await page.goto("/profile");
  const form = page.locator("#my-profile-form");
  const save = form.locator("[data-save-button]");
  await expect(save).toBeDisabled();
  await form.locator('wa-input[name="firstName"] input').fill("Casey Jo");
  await expect(save).toBeEnabled();
  await save.click();
  // Profile saves are quiet: success shows as a redrawn, clean form, not a toast.
  await expect(form.locator('wa-input[name="firstName"] input')).toHaveValue(
    "Casey-Jo",
  );
  await expect(page.locator("#profile-title")).toBeFocused();
  // An unchanged empty phone is not sent.
  expect(api.calls("PUT", /^profile$/)[0].body).toEqual({
    firstName: "Casey Jo",
    lastName: "Manager",
    phoneExtension: "",
  });
});
