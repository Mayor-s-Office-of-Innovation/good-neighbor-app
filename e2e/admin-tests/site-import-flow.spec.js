import { test, expect, mockAdmin } from "./admin-mock.js";
import {
  importPreview as preview,
  importRows as rows,
} from "./site-import-helpers.js";
import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
const results = (page) =>
  page.locator('[aria-labelledby="import-results-title"]');

const csv = {
  name: "sites.csv",
  mimeType: "text/csv",
  buffer: Buffer.from("Provider,Program,Site name\nExample,Example,Example\n"),
};

/** @param {import("@playwright/test").Page} page */
async function signedIn(page) {
  // The signed-in render replaces the form, so a file chosen before it is lost.
  await expect(page.locator("admin-app h1")).toBeFocused();
}

/** @param {import("@playwright/test").Page} page */
async function choosePreview(page) {
  await signedIn(page);
  await page.locator('input[name="site-import-file"]').setInputFiles(csv);
  await page.locator('#site-import-form button[type="submit"]').click();
  await expect(page.locator("#review-title")).toBeVisible();
}

test("applying polls until complete and confirms success", async ({ page }) => {
  const api = await mockAdmin(page);
  api.on("POST", /^site-imports\/preview$/, {
    json: { ...preview, counts: { create: 2 }, rows: rows.slice(0, 2) },
  });
  const replies = [
    { status: "applying", outcomes: { applied: 1 }, rows: rows.slice(0, 2) },
    { status: "complete", resultStatus: "succeeded", outcomes: { applied: 2 } },
  ];
  api.on("POST", /^site-imports\/i1\/apply$/, () => ({
    json: replies.shift(),
  }));
  await page.goto("/sites/import");
  await choosePreview(page);
  await page.locator("#apply-site-import").click();
  // A finished import keeps its results on screen, at a link that reopens them.
  await expect(results(page)).toContainText(
    t("admin.import.outcomeCounts", { applied: 2, failed: 0 }),
  );
  await expect(page).toHaveURL(/\/sites\/import\?importId=i1$/);
  expect(api.calls("POST", /^site-imports\/i1\/apply$/)).toHaveLength(2);
  await expect(page.locator("app-toasts")).toContainText(
    t("admin.toast.importComplete", { count: 2 }),
  );
});

test("the conflict report downloads", async ({ page }) => {
  const api = await mockAdmin(page);
  api.on("POST", /^site-imports\/preview$/, { json: preview });
  api.on("GET", /^site-imports\/i1\/conflicts\.csv$/, {
    body: "Row,Reason\n8,site_conflict\n",
    contentType: "text/csv",
  });
  await page.goto("/sites/import");
  await choosePreview(page);
  // app-site-import.test.js checks a failed download.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#download-import-conflicts").click(),
  ]);
  expect(download.suggestedFilename()).toBe("site-import-i1-conflicts.csv");
});
