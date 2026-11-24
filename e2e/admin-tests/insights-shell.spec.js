import { test, expect, mockAdmin, pageError, settle } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { typeInto, openSite } from "./site-record-helpers.js";

/** @param {import("@playwright/test").Page} page @param {"manage" | "insights"} mode */
const tab = (page, mode) => page.locator(`#admin-modes a[data-mode="${mode}"]`);
/** @param {import("@playwright/test").Page} page */
const heading = (page) => page.getByRole("heading", { level: 1 });

test("an admin moves between Manage and Insights pages and back", async ({
  page,
}) => {
  const api = await mockAdmin(page, { insights: true });
  await page.goto("/insights");
  await expect(heading(page)).toHaveText(t("admin.insights.overview"));
  await expect(page.locator("[data-site-row]").first()).toBeVisible();
  // So opening Insights never waits on Manage's Site and record reads; it
  // reads only the shared lists that name its filters.
  await settle(page);
  // Sorted: the reads go out together and can arrive in any order.
  expect(
    ["GET", "POST", "PUT", "PATCH", "DELETE"]
      .flatMap((method) =>
        api.calls(method, /^(?!session(?:\?|$)|reporting\/)/),
      )
      .map((c) => c.path + c.search)
      .sort(),
  ).toEqual(["oversight-options", "program-managers", "programs", "providers"]);
  await page.locator('#insights-nav a[data-insights-nav="trends"]').click();
  await expect(heading(page)).toHaveText(t("admin.insights.trends"));
  await tab(page, "manage").click();
  await expect(page.locator("#directory-title")).toBeVisible();
  await expect(tab(page, "manage")).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await expect(page).toHaveURL(/\/insights\/trends$/);
  await expect(heading(page)).toHaveText(t("admin.insights.trends"));
});

test("unsaved Site edits ask first, and once saved Insights opens", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  await openSite(page);
  await typeInto(page, "site-name", "Example Site Renamed");
  await tab(page, "insights").click();
  const dialog = page.locator("#site-unsaved-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator('button[value="keep"]').click();
  await expect(dialog).toBeHidden();
  await settle(page);
  await expect(page).toHaveURL(/\/sites\/s1$/);
  await expect(heading(page)).toHaveText("Example Site");
  await page.locator("[data-save-site-details]").click();
  await expect(heading(page)).toHaveText("Example Site Renamed");
  await tab(page, "insights").click();
  await expect(heading(page)).toHaveText(t("admin.insights.overview"));
});

test("when Insights can't download, Manage keeps working", async ({ page }) => {
  await mockAdmin(page, { insights: true });
  // Matches the built, hashed file and the dev server's source path alike.
  await page.route(/\/insights\.pages[-\w]*\.js(\?|$)/, (route) =>
    route.abort(),
  );
  await page.goto("/sites");
  await tab(page, "insights").click();
  await expect(pageError(page)).toHaveText(t("admin.insights.loadError"));
  await tab(page, "manage").click();
  await expect(page.locator("#directory-title")).toBeVisible();
  await expect(pageError(page)).toHaveCount(0);
});

test("an old Analytics bookmark opens Insights", async ({ page }) => {
  await mockAdmin(page, { insights: true });
  // The CDN serves .html paths as files, not index.html, so the file itself must redirect.
  await page.goto("/analytics.html");
  await expect(page).toHaveURL(/\/insights$/);
  await expect(heading(page)).toHaveText(t("admin.insights.overview"));
});

test("signing in from an Insights page comes back to it", async ({ page }) => {
  await mockAdmin(page, { insights: true });
  await page.addInitScript(() => {
    const config = /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG;
    Object.assign(config, {
      localDebugAdmin: false,
      cognitoDomain: "https://auth.example.org",
      clientId: "example-client",
      redirectUri: `${window.location.origin}/auth/callback`,
    });
  });
  // Stands in for Cognito: approves at once and sends the code back.
  await page.route("https://auth.example.org/oauth2/authorize?*", (route) => {
    const sent = new URL(route.request().url()).searchParams;
    const back = new URL(sent.get("redirect_uri") ?? "");
    back.search = new URLSearchParams({
      code: "c1",
      state: sent.get("state") ?? "",
    }).toString();
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });
  await page.route("https://auth.example.org/oauth2/token", (route) =>
    route.fulfill({ json: { access_token: "token-1", expires_in: 3600 } }),
  );
  await page.goto("/insights/trends");
  await page.locator("#sign-in").click();
  await expect(page).toHaveURL(/\/insights\/trends$/);
  await expect(heading(page)).toHaveText(t("admin.insights.trends"));
});
