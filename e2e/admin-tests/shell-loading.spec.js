import { test, expect, mockAdmin, pageError } from "./admin-mock.js";
import { failTimes } from "./directory-helpers.js";
import { t } from "../helpers/i18n.js";

test("signing out leaves the debug session through the logout page", async ({
  page,
}) => {
  await mockAdmin(page);
  await page.goto("/sites");
  await page.evaluate(() =>
    window.sessionStorage.setItem("good-neighbor-admin-access-token", "stale"),
  );
  await page.locator('[popovertarget="admin-settings-menu"]').click();
  // A document request, unlike framenavigated, proves the page really left.
  const logout = page.waitForRequest(
    (request) =>
      request.isNavigationRequest() && new URL(request.url()).pathname === "/",
  );
  // The new page must load before evaluate, or the old document dies under it.
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#clear-token").click(),
  ]);
  await logout;
  await expect(page.locator("#directory-title")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.sessionStorage.getItem("good-neighbor-admin-access-token"),
    ),
  ).toBeNull();
});

test("a configured sign-in sends the visitor to the login page", async ({
  page,
}) => {
  await mockAdmin(page);
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      cognitoDomain: "https://auth.example.org",
      clientId: "example-client",
      localDebugAdmin: false,
    };
  });
  await page.route("https://auth.example.org/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Login</p>" }),
  );
  await page.goto("/sites");
  await expect(page.locator("#sign-in")).toBeVisible();
  await page.locator("#sign-in").click();
  await expect(page).toHaveURL(/auth\.example\.org\/oauth2\/authorize/);
});

// Unit tests mock location.reload; these check a real reload.
test("a failed session read offers a reload that recovers", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  api.on("GET", /^session$/, failTimes(1));
  await page.goto("/sites");
  // A server's own text never reaches the error line, even a sentence.
  await expect(pageError(page)).toHaveText(t("admin.toast.requestFailed"));
  // No role yet, so retry reloads the page instead of reopening the route.
  await page.locator("#retry-page-load").click();
  await expect(page.locator("#directory-title")).toBeVisible();
  await expect(page.locator("#retry-page-load")).toHaveCount(0);
});

test("the local role switch reloads as the chosen role", async ({ page }) => {
  const api = await mockAdmin(page);
  await page.goto("/sites");
  await expect(page.locator("#directory-title")).toBeVisible();
  // selectOption returns before the reload; an evaluate could die with the old document.
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("#local-role-switch").selectOption("manager"),
  ]);
  await expect(page.locator("#local-role-switch")).toHaveValue("manager");
  const roles = () =>
    api
      .calls("GET", /^session$/)
      .map((request) => request.headers["x-debug-groups"]);
  // The reloaded page's session read can reach the mock after the load event.
  await expect.poll(() => roles().at(-1)).toBe("compliance-manager");
  expect(roles()[0]).toBe("compliance-supervisor");
});
