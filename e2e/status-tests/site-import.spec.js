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
