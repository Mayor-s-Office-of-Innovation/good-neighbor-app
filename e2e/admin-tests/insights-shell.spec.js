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
  await expect(page.locator("[data-insights-freshness]")).toHaveText(
    t("admin.insights.dataAsOfPending"),
  );
  // So opening Insights never waits on Manage's directory reads.
  await settle(page);
  expect(
    ["GET", "POST", "PUT", "PATCH", "DELETE"].flatMap((method) =>
      api.calls(method, /^(?!session(?:\?|$))/),
    ),
  ).toEqual([]);
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

test("Manage site leads back to Site insights with its filters", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  await page.goto("/insights/sites/s1?period=2026-09");
  await page.locator("#insights-manage-site").click();
  await expect(heading(page)).toHaveText("Example Site");
  await page.locator('a[href^="/sites/s1?section=oversight"]').click();
  await expect(page.locator("#site-oversight-form")).toBeVisible();
  await page.locator("#insights-return").click();
  await expect(page).toHaveURL(/\/insights\/sites\/s1\?period=2026-09$/);
  await expect(page.locator("#insights-manage-site")).toBeFocused();
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
