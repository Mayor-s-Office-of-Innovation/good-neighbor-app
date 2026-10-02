// @ts-check
import { test as base, expect } from "@playwright/test";
import { bindSite } from "./app.js";

/**
 * Per-test isolation: every test gets a fresh browser context (Playwright
 * default) bound to the seeded site through the real code-entry flow. IndexedDB
 * state (site binding, drafts) is per-context, so no cross-test leakage.
 *
 * The fixture body is exported so a suite can compose it onto a different
 * base (e.g. the ramp-check a11y fixtures in a11y.e2e.spec.js) without
 * duplicating the flow.
 * @param {{ page: import("@playwright/test").Page }} fixtures
 * @param {(page: import("@playwright/test").Page) => Promise<void>} use
 */
export async function boundPage({ page }, use) {
  await bindSite(page);
  await use(page);
}

export const test = base.extend({ page: boundPage });

export { expect };
