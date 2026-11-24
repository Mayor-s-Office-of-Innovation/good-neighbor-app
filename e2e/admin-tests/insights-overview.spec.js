import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { failTimes } from "./directory-helpers.js";

/** @param {import("@playwright/test").Page} page */
const siteRows = (page) => page.locator("[data-site-row]");

/**
 * Activity tiles whose drawn number runs under their "?" button.
 * @param {import("@playwright/test").Page} page
 */
const tipsOverNumbers = (page) =>
  page.locator("[data-activity]").evaluateAll((tiles) =>
    tiles
      .filter((tile) => {
        const words = document.createRange();
        words.selectNodeContents(
          /** @type {Node} */ (tile.querySelector("[data-tile-n]")),
        );
        const tip = /** @type {Element} */ (
          tile.querySelector("[popovertarget]")
        ).getBoundingClientRect();
        return [...words.getClientRects()].some(
          (r) =>
            r.right > tip.left &&
            r.left < tip.right &&
            r.bottom > tip.top &&
            r.top < tip.bottom,
        );
      })
      .map((tile) => tile.getAttribute("data-activity")),
  );

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
  // The Issue opens beside the Site, and Esc puts the user back on its row.
  await page.locator('[data-issue-row="t2"] a').click();
  await expect(
    page.getByRole("dialog", { name: t("admin.insights.panel.issue") }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-record-panel]")).toHaveCount(0);
  await expect(page.locator('[data-issue-row="t2"] a')).toBeFocused();
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

test("on a 320px phone, Overview fits without sideways scrolling, and at 430px a Site's tile numbers clear their ? buttons", async ({
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
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/insights/sites/s1?period=2026-10");
  await expect(page.locator("[data-activity]").first()).toBeVisible();
  expect(await tipsOverNumbers(page)).toEqual([]);
});

test("a Site's financial year draws the months before its records as no data, not as its busiest months", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  // The fake's records begin Jan 1, 2026, so Jul–Dec 2025 have no data.
  await page.goto("/insights/sites/s1?period=fy2025");
  const none = page.locator(
    '[data-chart="checks"] [data-bar="none"] [data-bar-fill]',
  );
  await expect(none).toHaveCount(6);
  // Only the browser's cascade shows whether the hatch or the series colour wins.
  const fills = await none.evaluateAll((bars) =>
    bars.map((bar) => window.getComputedStyle(bar).backgroundImage),
  );
  expect(fills).toEqual(
    fills.map(() => expect.stringContaining("repeating-linear-gradient")),
  );
});

test("at 1280px, Overview column heads keep their spaces and a Site's month labels don't overlap; narrower, its day calendars stay in their columns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockAdmin(page, { insights: true });
  await page.goto("/insights?period=2026-10&show=all");
  await expect(siteRows(page)).toHaveCount(4);
  // The gap between a head's last two words, measured where the browser drew them.
  const gaps = await page.locator("[data-sort-key]").evaluateAll((heads) =>
    heads
      .filter((head) => head.firstChild?.textContent?.trim())
      .map((head) => {
        const words = document.createRange();
        words.selectNodeContents(/** @type {Node} */ (head.firstChild));
        const before = [...words.getClientRects()].at(-1);
        const last = /** @type {Element} */ (
          head.querySelector("[data-sort-last]")
        ).getBoundingClientRect();
        return last.top > (before?.top ?? 0) + 1
          ? 4
          : last.left - (before?.right ?? 0);
      }),
  );
  expect(gaps.length).toBeGreaterThan(0);
  expect(gaps.every((gap) => gap >= 2)).toBe(true);
  await page.goto("/insights/sites/s1?period=2026");
  await expect(page.locator("[data-bar-label]").first()).toBeAttached();
  // Each month's label must end before the next one starts.
  const overlaps = await page
    .locator('[data-chart-panel="checks"] [data-bar-label]')
    .evaluateAll((spans) => {
      const drawn = spans
        .filter((s) => s.textContent?.trim())
        .map((s) => {
          const r = document.createRange();
          r.selectNodeContents(s);
          const rects = [...r.getClientRects()];
          return {
            left: Math.min(...rects.map((x) => x.left)),
            right: Math.max(...rects.map((x) => x.right)),
          };
        });
      return drawn.filter((d, i) => i && d.left < drawn[i - 1].right).length;
    });
  expect(overlaps).toBe(0);
  expect(await tipsOverNumbers(page)).toEqual([]);
  // Three 7-day calendars need about 870px; narrower sections must stack them.
  for (const width of [900, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/insights/sites/s1?period=2026-10");
    await expect(page.locator("[data-cal]").first()).toBeAttached();
    const spill = await page
      .locator("[data-chart-panel]")
      .evaluateAll((panels) =>
        panels.map((panel) => {
          const cal = /** @type {Element} */ (panel.querySelector("table"));
          return Math.max(
            0,
            Math.round(
              cal.getBoundingClientRect().right -
                panel.getBoundingClientRect().right,
            ),
          );
        }),
      );
    expect(spill).toEqual([0, 0]);
  }
});
