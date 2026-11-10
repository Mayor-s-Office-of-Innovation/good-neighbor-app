import { expect } from "./admin-mock.js";

/**
 * Type into a Web Awesome input the way a person does, so the form sees
 * trusted events and enables its Save action.
 * @param {import("@playwright/test").Page} page
 * @param {string} name
 * @param {string} value
 */
export async function typeInto(page, name, value) {
  const input = page.locator(`admin-app wa-input[name="${name}"] input`);
  await input.click();
  await input.fill(value);
}

/**
 * Pick an option in a Web Awesome select with real clicks, since the Site
 * forms ignore untrusted change events when marking a section edited.
 * @param {import("@playwright/test").Page} page
 * @param {string} name
 * @param {string} value
 */
export async function pickOption(page, name, value) {
  const select = page.locator(`admin-app wa-select[name="${name}"]`);
  await select.click();
  await select.locator(`wa-option[value="${value}"]`).click();
  // Reopening during wa-select's close animation leaves its list stuck hidden.
  await expect(select.getByRole("listbox")).toBeHidden();
}

/**
 * Open a Site section and wait for its record.
 * @param {import("@playwright/test").Page} page
 * @param {string} [path]
 */
export async function openSite(page, path = "/sites/s1") {
  await page.goto(path);
  // Only the Site h1 has no id, so a redirect to the directory doesn't count.
  await expect(page.locator("admin-app h1:not([id])")).toBeVisible();
}
