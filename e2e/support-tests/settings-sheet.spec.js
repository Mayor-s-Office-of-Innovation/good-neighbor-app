import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";
import { stubReports } from "../helpers/reports.js";
import { routeHomeLists } from "../helpers/app.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [] } }),
  );
  // Home reads its lists through GET /v1/home, which needs the section shape.
  await routeHomeLists(page);
  await page.route("**/__support_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Support test</title></head><body><main></main><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__support_test");
  await page.evaluate(async () => {
    await window.customElements.whenDefined("today-view");
    const dbPath = "/src/db.js";
    const { setSite } = await import(dbPath);
    await setSite("Support test site", {
      siteId: "support-test",
      token: "mock-token",
      accessLevel: "manager",
    });
    // Use the production app shell, route table, lazy loading, and history.
    document.querySelector("main")?.remove();
    document.body.append(document.createElement("app-root"));
  });
  await expect(page.locator("#home-settings")).toBeEnabled();
  await page.locator("#home-settings").click();
  await page.locator("#settings-help").click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.locator("support-view h1")).toHaveText(t("support.title"));
});

test("Settings contains keyboard focus, its footer, and accessible menu content", async ({
  page,
}) => {
  await page.locator("support-view [data-menu-back]").click();
  const sheet = page.getByRole("dialog", { name: t("today.settings.title") });
  const close = sheet.locator("#settings-close");
  const last = sheet.locator("#settings-logout");
  await expect(close).toBeFocused();
  await last.focus();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    await expect(page.locator("#start-check")).not.toBeFocused();
  }
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#start-check")).not.toBeFocused();
  for (const width of [320, 620, 1136]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(sheet).toHaveCSS("opacity", "1");
    const contained = await sheet.evaluate((el) => {
      const footer = el.querySelector("#settings-release-version");
      if (!footer) return false;
      const box = el.getBoundingClientRect();
      const r = footer.getBoundingClientRect();
      return (
        r.left >= box.left &&
        r.right <= box.right &&
        r.top >= box.top &&
        r.bottom <= box.bottom
      );
    });
    expect(contained).toBe(true);
    const widths = await sheet.evaluate((el) => {
      const style = window.getComputedStyle(el);
      const available =
        el.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      return [".home-settings-head", ".home-settings-actions"].map(
        (selector) => {
          const child = el.querySelector(selector);
          if (!child)
            throw new Error(`Missing Settings container: ${selector}`);
          return Math.abs(child.getBoundingClientRect().width - available);
        },
      );
    });
    for (const difference of widths) expect(difference).toBeLessThan(1);
  }
  const audit = await new AxeBuilder({ page })
    .include("dialog.home-settings-menu")
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("#home-settings")).toBeFocused();
});

for (const status of [204, 503]) {
  test(`leaving Feedback ignores a late ${status} response`, async ({
    page,
  }) => {
    /** @type {() => void} */
    let release = () => {};
    let started = false;
    const pending = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    await page.route("**/v1/feedback", async (route) => {
      started = true;
      await pending;
      await route.fulfill({ status });
    });
    await page.locator("support-view [data-menu-back]").click();
    await page.locator("#settings-feedback").click();
    await page
      .locator("#feedback-text textarea")
      .fill("Synthetic pending feedback");
    await page.locator("#feedback-send").click();
    await expect.poll(() => started).toBe(true);
    await page.locator("feedback-view [data-menu-back]").click();
    await page.locator("#settings-language").click();
    await expect(page).toHaveURL(/\/language$/);
    const response = page.waitForResponse("**/v1/feedback");
    release();
    await response;
    // Let the request's continuation settle before checking for stale effects.
    await page.waitForTimeout(100);
    await expect(page).toHaveURL(/\/language$/);
    await expect(
      page.locator(
        ".app-toast--success, .app-toast--error, [data-operation-error]",
      ),
    ).toHaveCount(0);
  });
}

for (const back of ["button", "browser"]) {
  test(`Reports ${back} Back reopens Settings`, async ({ page }) => {
    await stubReports(page);
    // Exercise synchronous route swaps as used without View Transitions.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("support-view [data-menu-back]").click();
    await page.locator("#settings-reports").click();
    await expect(page.locator("#reports-back")).toBeVisible();
    if (back === "button") await page.locator("#reports-back").click();
    else await page.goBack();
    await expect(page.locator("dialog.home-settings-menu[open]")).toBeVisible();
  });
}

for (const cancel of ["button", "Escape"]) {
  test(`Log out ${cancel} cancellation reopens Settings`, async ({ page }) => {
    await page.locator("support-view [data-menu-back]").click();
    await page.locator("#settings-logout").click();
    await expect(page.locator("#logout-dialog[open]")).toBeVisible();
    if (cancel === "button")
      await page.locator(".logout-dialog__cancel").click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("dialog.home-settings-menu[open]")).toBeVisible();
    await expect(page.locator("#settings-close")).toBeFocused();
  });
}

test("offline banner does not block Settings Log out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("support-view [data-menu-back]").click();
  await page.context().setOffline(true);
  await expect(page.locator(".app-connection-banner")).toBeVisible();
  await page.locator("#settings-logout").click({ timeout: 5000 });
  await expect(page.locator("#logout-dialog[open]")).toBeVisible();
});
