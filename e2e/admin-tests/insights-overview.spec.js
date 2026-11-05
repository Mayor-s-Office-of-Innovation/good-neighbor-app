import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { failTimes, setControl } from "./directory-helpers.js";

/** @param {import("@playwright/test").Page} page */
const siteRows = (page) => page.locator("[data-site-row]");

test("a manager filters Overview, opens a Site, visits Manage and comes back to the same view", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  await page.goto("/insights?period=2026-10");
  await expect(siteRows(page)).toHaveCount(2);
  await setControl(
    page.locator('wa-select[data-filter="responseState"]'),
    "late",
  );
  await expect(page).toHaveURL(/responseState=late/);
  await page.locator('[data-site-link="s1"]').click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Example Site",
  );
  await page.locator("#insights-manage-site").click();
  await expect(page.locator("#insights-return")).toBeVisible();
  await page.locator("#insights-return").click();
  await expect(page).toHaveURL(/\/insights\/sites\/s1\?period=2026-10$/);
  await page.locator("#insights-back").click();
  await expect(page).toHaveURL(
    /\/insights\?period=2026-10&responseState=late$/,
  );
  await expect(page.locator('[data-site-link="s1"]')).toBeFocused();
});

test("a manager picks Sites and gets a report link without leaving the page", async ({
  page,
}) => {
  const api = await mockAdmin(page, { insights: true });
  // The report polls every 2 seconds; a fake clock skips the wait.
  await page.clock.install();
  await page.goto("/insights?period=2026-10&show=all");
  await page.locator('[data-select-site="s1"]').click();
  await page.locator('[data-select-site="s4"]').click();
  await page.locator("#insights-report").click();
  await page.locator("#insights-report-confirm").click();
  await expect(page.locator("#insights-report-cancel")).toBeVisible();
  await page.clock.runFor(2000);
  await expect(page.locator("#insights-report-download")).toBeVisible();
  expect(api.calls("POST", /^reports\/insights$/)[0].body.siteIds).toEqual([
    "s1",
    "s4",
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
  await expect(page.locator("#insights-count")).toHaveText(
    t("admin.insights.siteCount", { count: 2 }),
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
