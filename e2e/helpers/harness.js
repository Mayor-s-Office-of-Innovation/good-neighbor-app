// @ts-check
import { test as base, expect } from "@playwright/test";
import { bindSite } from "./app.js";

/**
 * Per-test isolation: every test gets a fresh browser context (Playwright
 * default) bound to the seeded site through the real code-entry flow. IndexedDB
 * state (site binding, drafts) is per-context, so no cross-test leakage.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await bindSite(page);
    await use(page);
  },
});

export { expect };
