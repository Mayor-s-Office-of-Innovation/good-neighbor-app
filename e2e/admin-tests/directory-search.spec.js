import { test, expect, mockAdmin } from "./admin-mock.js";
import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
const searchInput = (page) => page.locator("#directory-search-input input");

test("search lists matching Sites, Programs, Providers and managers", async ({
  page,
}) => {
  const api = await mockAdmin(page);
  api.data.programs[0] = /** @type {any} */ ({
    ...api.data.programs[0],
    providerName: "Example Provider",
  });
  await page.goto("/sites");
  await searchInput(page).fill("Example");
  await expect(page).toHaveURL(/q=Example/);
  const results = page.locator("#directory-results");
  // Each result group is headed by its type.
  await expect(results.getByRole("heading", { level: 3 })).toHaveCount(4);
  await expect(results).toContainText("Example Program — Example Provider");
  await expect(results.locator('a[href="/managers/u1"]')).toBeVisible();
  await expect(results.locator("p[role='status']")).toHaveText(
    t("admin.directory.resultCount", { count: 4 }),
  );
});
