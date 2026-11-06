import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { setControl } from "./directory-helpers.js";

test("a manager opens a Severe Issue beside the list, follows its Check, opens the full record and comes back to the same row", async ({
  page,
}) => {
  await mockAdmin(page, { insights: true });
  await page.goto("/insights/raw/issues?period=2026-10");
  await setControl(
    page.locator('wa-select[data-filter="severityBand"]'),
    "severe",
  );
  await expect(page).toHaveURL(/severityBand=severe/);
  await expect(
    page.locator("[data-insights-table] [data-record-link]"),
  ).toHaveCount(1);
  await page.locator('[data-record-link="s1|t1"]').click();
  const panel = page.getByRole("dialog", {
    name: t("admin.insights.panel.issue"),
  });
  await expect(panel).toBeVisible();
  // The list stays where it was behind the panel.
  await expect(page).toHaveURL(
    /\/insights\/raw\/issues\?period=2026-10&severityBand=severe$/,
  );
  await panel.locator("[data-parent-check]").click();
  await expect(
    page.getByRole("dialog", { name: t("admin.insights.panel.check") }),
  ).toBeVisible();
  await page.locator("#insights-panel-full").click();
  await expect(page).toHaveURL(/\/insights\/raw\/checks\/c1\?/);
  await page.locator('[data-crumb="root"]').click();
  await expect(page).toHaveURL(
    /\/insights\/raw\/issues\?period=2026-10&severityBand=severe$/,
  );
  await expect(page.locator('[data-record-link="s1|t1"]')).toBeFocused();
});

test("a manager exports every filtered Issue as CSV and stays on the list", async ({
  page,
}) => {
  const api = await mockAdmin(page, { insights: true });
  // The export polls every 2 seconds; a fake clock skips the wait.
  await page.clock.install();
  await page.goto("/insights/raw/issues?period=2026-10&severityBand=severe");
  await expect(
    page.locator("[data-insights-table] [data-record-link]"),
  ).toHaveCount(1);
  await page.locator("#insights-export").click();
  // The dialog counts what the list counted.
  await expect(page.locator("#insights-export-title")).toHaveText(
    t("admin.insights.export.title.issues", { count: 1 }),
  );
  await page.locator("#insights-export-confirm").click();
  await expect(page.locator("#insights-export")).toHaveText(
    t("admin.insights.export.exporting"),
  );
  await page.clock.runFor(2000);
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    t("admin.insights.export.done"),
  );
  await expect(page.locator("#insights-export-download")).toBeVisible();
  const [post] = api.calls("POST", /^reporting\/exports$/);
  expect(post.body).toEqual({
    dataset: "issues",
    period: "month",
    month: "2026-10",
    severityBand: "severe",
    sort: "latestActivityAt",
  });
  await expect(page).toHaveURL(
    /\/insights\/raw\/issues\?period=2026-10&severityBand=severe$/,
  );
});
