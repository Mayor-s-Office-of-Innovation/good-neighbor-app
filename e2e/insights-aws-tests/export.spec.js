import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { t } from "../helpers/i18n.js";
import { useLocalApi } from "./lake.js";

// Its `empty-lake` project has left the projection in the lake.
test("a supervisor exports the Issues as CSV and downloads the file", async ({
  page,
}) => {
  await useLocalApi(page);
  await page.goto("/insights/raw/issues?period=2026-10");
  const rows = page.locator("[data-insights-table] [data-record-link]");
  await expect(rows).toHaveCount(4);

  await page.locator("#insights-export").click();
  await page.locator("#insights-export-confirm").click();
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    t("admin.insights.export.done"),
    { timeout: 30_000 },
  );

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#insights-export-download").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  const csv = await readFile(await download.path(), "utf8");
  const [header, ...lines] = csv
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r\n/);
  expect(header.split(",").slice(0, 3)).toEqual([
    "Issue ID",
    "Site",
    "Site ID",
  ]);
  expect(lines.map((line) => line.split(",")[0]).sort()).toEqual([
    "t1",
    "t2",
    "t3",
    "t5",
  ]);
});
