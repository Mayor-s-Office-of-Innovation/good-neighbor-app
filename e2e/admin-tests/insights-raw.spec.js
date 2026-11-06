import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";
import { setControl } from "./directory-helpers.js";

test("a supervisor opens a Severe Issue beside the list, sees its photos and notes, follows its Check, opens the full record and comes back to the same row", async ({
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
  await expect(panel.locator('[data-photo-open="t1-u2-p1"] img')).toBeVisible();
  await expect(panel.locator("[data-record-notes]")).toContainText(
    "Synthetic note",
  );
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

test("a compliance manager sees an Issue's record without its photos", async ({
  page,
}) => {
  const api = await mockAdmin(page, {
    insights: true,
    role: "compliance-manager",
  });
  await page.goto("/insights/raw/issues?period=2026-10");
  await page.locator('[data-record-link="s1|t1"]').click();
  const panel = page.getByRole("dialog", {
    name: t("admin.insights.panel.issue"),
  });
  // The parent Check link renders with the photos region, so its absence is real.
  await expect(panel.locator("[data-parent-check]")).toBeVisible();
  await expect(panel.locator("[data-record-photos]")).toHaveCount(0);
  await api.expectNotSent("GET", /record-photos/);
});

test("a supervisor exports every filtered Issue as CSV and stays on the list", async ({
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
  // The poll's timer starts only once the POST returns, so step the clock until it fires.
  await expect(async () => {
    await page.clock.runFor(2000);
    await expect(page.getByRole("dialog")).toHaveAccessibleName(
      t("admin.insights.export.done"),
      { timeout: 500 },
    );
  }).toPass();
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
