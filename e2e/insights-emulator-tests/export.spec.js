import { readFile } from "node:fs/promises";
import { EXPORT_COLUMNS } from "../../backend/src/reporting/api/read-model.js";
import { t } from "../helpers/i18n.js";
import { expect, test, uploadProjection, useLocalApi } from "./lake.js";

test.beforeAll(uploadProjection);

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
  expect(header.split(",")).toEqual(EXPORT_COLUMNS.issues);
  expect(lines.map((line) => line.split(",")[0]).sort()).toEqual([
    "t1",
    "t2",
    "t3",
    "t5",
  ]);
});
