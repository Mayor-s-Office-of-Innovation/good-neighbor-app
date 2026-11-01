import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/admin/v1/**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/session")
        ? {
            role: "compliance-supervisor",
            capabilities: { createEntities: true },
          }
        : { imports: [] },
    }),
  );
});

/** @type {Array<[number, string, string]>} */
const rejections = [
  [
    400,
    JSON.stringify({ error: "invalid_encoding" }),
    "admin.import.invalidEncoding",
  ],
  [
    400,
    JSON.stringify({ error: "unreadable_csv" }),
    "admin.import.unreadableCsv",
  ],
  [
    400,
    JSON.stringify({ error: "invalid_headers" }),
    "admin.import.invalidHeaders",
  ],
  [
    400,
    JSON.stringify({ error: "invalid_row_count" }),
    "admin.import.invalidRowCount",
  ],
  [403, "<html>Request blocked</html>", "admin.errors.requestBlocked"],
  [413, "<html>Payload too large</html>", "admin.errors.requestTooLarge"],
  [
    413,
    JSON.stringify({ error: "request_too_large" }),
    "admin.errors.requestTooLarge",
  ],
];

for (const [status, body, key] of rejections) {
  test(`import rejection ${status} (${body}) stays local and can be retried`, async ({
    page,
  }) => {
    let attempts = 0;
    const csv = "Synthetic CSV data\n".repeat(1400);
    await page.route("**/admin/v1/site-imports/preview", async (route) => {
      expect(route.request().postDataJSON().csv).toBe(csv);
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status,
          body,
          contentType: body.startsWith("<") ? "text/html" : "application/json",
        });
      } else {
        await route.fulfill({
          status: 201,
          json: {
            importId: "synthetic-import",
            previewVersion: "version-1",
            counts: {},
            rows: [],
          },
        });
      }
    });
    await page.goto("/sites/import");
    const input = page.locator('input[name="site-import-file"]');
    await input.setInputFiles({
      name: "synthetic.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.locator('#site-import-form button[type="submit"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".error")).toHaveText(t(key));
    await expect(page.locator(".app-connection-banner")).toBeHidden();
    await expect(
      page.locator('#site-import-form button[type="submit"]'),
    ).toBeEnabled();
    const accessibility = await new AxeBuilder({ page })
      .include(".error")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await input.setInputFiles({
      name: "synthetic.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    await page.locator('#site-import-form button[type="submit"]').focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#review-title")).toBeVisible();
    await expect(page.locator(".error")).toHaveCount(0);
    await expect(page.locator(".app-connection-banner")).toBeHidden();
    expect(attempts).toBe(2);
  });
}

test("oversized CSV is rejected before a request and explains the file limit", async ({
  page,
}) => {
  let attempted = false;
  await page.route("**/admin/v1/site-imports/preview", (route) => {
    attempted = true;
    return route.abort();
  });
  await page.goto("/sites/import");
  await page.locator('input[name="site-import-file"]').setInputFiles({
    name: "synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.alloc(1024 * 1024 + 1, "x"),
  });
  await page.locator('#site-import-form button[type="submit"]').click();
  await expect(page.locator(".error")).toHaveText(
    t("admin.import.fileTooLarge"),
  );
  await expect(page.locator(".app-connection-banner")).toBeHidden();
  expect(attempted).toBe(false);
});

for (const partial of [false, true]) {
  test(`completed import retains ${partial ? "partial" : "successful"} results, survives reload, and reopens from history`, async ({
    page,
  }) => {
    const source = {
      "Site name": "Synthetic Site",
      Provider: "Synthetic Provider",
      Program: "Synthetic Program",
    };
    const rows = [
      {
        rowNumber: 2,
        source,
        classification: "acceptable",
        outcome: "applied",
      },
      {
        rowNumber: 3,
        source,
        classification: "acceptable",
        outcome: partial ? "skipped_conflict" : "applied",
        reasonCode: partial ? "import_dependency_failed" : "",
      },
    ];
    const outcomes = {
      applied: partial ? 1 : 2,
      failed: 0,
      skipped_conflict: partial ? 1 : 0,
    };
    const counts = { acceptable: 2 };
    const importId = "synthetic-results";
    const result = {
      importId,
      status: "complete",
      resultStatus: partial ? "partial" : "succeeded",
      outcomes,
      rows,
    };
    let applyCalls = 0;
    await page.route("**/admin/v1/site-imports/preview", (route) =>
      route.fulfill({
        status: 201,
        json: {
          importId,
          previewVersion: "v1",
          counts,
          rows: rows.map((row) => ({ ...row, outcome: "", reasonCode: "" })),
        },
      }),
    );
    await page.route(`**/admin/v1/site-imports/${importId}/apply`, (route) => {
      applyCalls += 1;
      return route.fulfill({ json: result });
    });
    await page.route(`**/admin/v1/site-imports/${importId}`, (route) =>
      route.fulfill({ json: { import: { ...result, counts }, rows } }),
    );
    await page.route(
      `**/admin/v1/site-imports/${importId}/conflicts.csv`,
      (route) =>
        route.fulfill({
          contentType: "text/csv",
          body: "Row,Reason\n3,import_dependency_failed\n",
        }),
    );
    await page.route("**/admin/v1/site-imports", (route) =>
      route.fulfill({
        json: {
          imports: [
            {
              importId,
              fileName: "synthetic.csv",
              completedAt: "2026-11-01T21:00:00Z",
              recordsAdded: outcomes.applied,
              recordsFailed: outcomes.skipped_conflict,
              outcomes,
            },
          ],
        },
      }),
    );
    await page.goto("/sites/import");
    await page.locator('input[name="site-import-file"]').setInputFiles({
      name: "synthetic.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("synthetic"),
    });
    await page.locator('#site-import-form button[type="submit"]').click();
    await page.locator("#apply-site-import").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#import-results-title")).toHaveText(
      t("admin.import.resultsTitle"),
    );
    await expect(page.locator("#apply-site-import")).toHaveCount(0);
    await expect(page).toHaveURL(/importId=synthetic-results/);
    const results = page.locator(
      'section[aria-labelledby="import-results-title"]',
    );
    await expect(results.locator("tbody tr")).toHaveCount(2);
    if (partial) {
      await expect(results).toContainText(t("admin.import.dependencyFailed"));
      const download = page.waitForEvent("download");
      await page.locator("#download-import-conflicts").focus();
      await page.keyboard.press("Enter");
      expect((await download).suggestedFilename()).toContain(importId);
    } else
      await expect(page.locator("#download-import-conflicts")).toHaveCount(0);
    const accessibility = await new AxeBuilder({ page })
      .include('section[aria-labelledby="import-results-title"]')
      .analyze();
    expect(accessibility.violations).toEqual([]);
    if (partial) {
      await page.route("**/admin/v1/site-imports/other-results", (route) =>
        route.fulfill({
          json: {
            import: {
              importId: "other-results",
              status: "complete",
              counts: { acceptable: 1 },
              outcomes: { applied: 1, failed: 0, skipped_conflict: 0 },
            },
            rows: [rows[0]],
          },
        }),
      );
      await page.evaluate(() => {
        window.history.pushState(
          {},
          "",
          "/sites/import?importId=other-results",
        );
        window.dispatchEvent(new window.PopStateEvent("popstate"));
      });
      await expect(results.locator("tbody tr")).toHaveCount(1);
      await expect(page.locator('section.panel[role="status"]')).toHaveCount(0);
      await page.goBack();
      await expect(results.locator("tbody tr")).toHaveCount(2);
    }
    await page.reload();
    await expect(page.locator("#import-results-title")).toBeVisible();
    await expect(results.locator("tbody tr")).toHaveCount(2);
    await expect(page.locator("#apply-site-import")).toHaveCount(0);
    await page.locator("#cancel-site-import").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#site-import-form")).toBeVisible();
    await expect(page.locator("#import-results-title")).toHaveCount(0);
    await expect(page.locator('input[name="site-import-file"]')).toBeFocused();
    await page
      .locator(`a[data-route][href="/sites/import?importId=${importId}"]`)
      .click();
    await expect(page.locator("#import-results-title")).toBeVisible();
    await expect(page.locator("#apply-site-import")).toHaveCount(0);
    expect(applyCalls).toBe(1);
  });
}
