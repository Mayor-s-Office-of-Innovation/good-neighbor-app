import { t } from "../helpers/i18n.js";
import {
  deleteLatestProjection,
  expect,
  test,
  uploadProjection,
  useLocalApi,
} from "./lake.js";

test("Insights says its data isn't ready until the lake has a projection, then shows every Site", async ({
  page,
}) => {
  const siteRows = page.locator("[data-site-row]");
  await deleteLatestProjection();
  await useLocalApi(page);
  await page.goto("/insights?period=2026-10&show=all");
  await expect(page.getByRole("alert")).toContainText(
    t("admin.insights.error.snapshotUnavailable"),
  );
  await expect(siteRows).toHaveCount(0);

  await uploadProjection();
  await page.locator("#insights-retry").click();
  await expect(siteRows).toHaveCount(3);
  // t3, at severity 5, is s1's worst Issue of October.
  await expect(
    page.locator('[data-site-row="s1"] [data-issues]'),
  ).toContainText(t("admin.insights.severity.severe"));
});
