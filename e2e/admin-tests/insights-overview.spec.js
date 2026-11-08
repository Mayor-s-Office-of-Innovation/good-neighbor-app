import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { failTimes } from "./directory-helpers.js";

/** @param {import("@playwright/test").Page} page */
const siteRows = (page) => page.locator("[data-site-row]");

test("a manager picks a view on Overview, opens a Site, sees its Overdue Issues and comes back to the same view", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  await page.goto("/insights?period=2026-10");
  await expect(siteRows(page)).toHaveCount(2);
  await page.locator('[data-show="all"]').click();
  await expect(page).toHaveURL(/show=all/);
  await expect(siteRows(page)).toHaveCount(4);
  await page.locator('[data-site-link="s1"]').click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Example Site",
  );
  await expect(page.locator("[data-site-concerns]")).toBeVisible();
  await expect(page.locator('[data-tile="overdue"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('[data-issue-row="t2"]')).toBeVisible();
  await page.locator("#insights-back").click();
  await expect(page).toHaveURL(/\/insights\?period=2026-10&show=all$/);
  await expect(page.locator('[data-site-link="s1"]')).toBeFocused();
});

test("a manager selects every Site and gets a report link without leaving the page", async ({
  page,
}) => {
  const api = await mockAdmin(page, { insights: true });
  // The report polls every 2 seconds; a fake clock skips the wait.
  await page.clock.install();
  await page.goto("/insights?period=2026-10&show=all");
  await expect(siteRows(page)).toHaveCount(4);
  await page.locator("#insights-select-all").click();
  await expect(page.locator("#insights-report")).toHaveText(
    t("admin.insights.report.buttonCount", { count: 4 }),
  );
  await page.locator("#insights-report").click();
  await page.locator("#insights-report-confirm").click();
  await expect(page.locator("#insights-report")).toHaveText(
    t("admin.insights.report.generating"),
  );
  // The poll's timer starts only once the POST returns, so step the clock until it fires.
  await expect(async () => {
    await page.clock.runFor(2000);
    await expect(page.getByRole("dialog")).toHaveAccessibleName(
      t("admin.insights.report.done"),
      { timeout: 500 },
    );
  }).toPass();
  await expect(page.locator("#insights-report-download")).toBeVisible();
  expect(api.calls("POST", /^reports\/insights$/)[0].body.siteIds).toEqual([
    "s1",
    "s3",
    "s4",
    "s2",
  ]);
  await expect(page).toHaveURL(/\/insights\?/);
});

test("when Overview can't load, it says why and Retry brings the Sites back", async ({
  page,
}) => {
  const api = await mockAdmin(page, { insights: true });
  api.on(
    "GET",
    /^reporting\/overview/,
    failTimes(1, 503, "snapshot_unavailable"),
  );
  await page.goto("/insights");
  await expect(page.getByRole("alert")).toContainText(
    t("admin.insights.error.snapshotUnavailable"),
  );
  await expect(siteRows(page)).toHaveCount(0);
  await page.locator("#insights-retry").click();
  await expect(siteRows(page)).toHaveCount(2);
  // Top concerns narrows the list, so the count names every Site too.
  await expect(page.locator("#insights-count")).toHaveText(
    t("admin.insights.siteCountOf", { count: 2, total: 4 }),
  );
});

test("on a 320px phone, Overview fits without sideways scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await mockAdmin(page, { insights: true });
  await page.goto("/insights?show=all");
  await expect(siteRows(page)).toHaveCount(4);
  // The table's own scroll box would hide sideways scrolling from the page.
  const overflow = await page.evaluate(() =>
    [
      document.documentElement,
      document.querySelector("[data-insights-table]"),
    ].map((el) => (el ? el.scrollWidth - el.clientWidth : null)),
  );
  expect(overflow).toEqual([0, 0]);
});

test("a Site's financial year draws the months before its records as no data, not as its busiest months", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  // The fake's records begin Jan 1, 2026, so Jul–Dec 2025 have no data.
  await page.goto("/insights/sites/s1?period=fy2025");
  const none = page.locator('[data-chart="checks"] [data-bar="none"] i');
  await expect(none).toHaveCount(6);
  // Only the browser's cascade shows whether the hatch or the series colour wins.
  const fills = await none.evaluateAll((bars) =>
    bars.map((bar) => window.getComputedStyle(bar).backgroundImage),
  );
  expect(fills).toEqual(
    fills.map(() => expect.stringContaining("repeating-linear-gradient")),
  );
});
