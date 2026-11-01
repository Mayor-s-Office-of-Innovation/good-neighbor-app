import { test, expect } from "@playwright/test";

test("connection retry gives bounded busy feedback and recovers immediately", async ({
  page,
}) => {
  await page.route("**/__prelaunch", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><head><title>Local UI test</title></head><body><main><h1>Local UI test</h1></main></body></html>',
    }),
  );
  await page.goto("/__prelaunch");
  const labels = await page.evaluate(async () => {
    const healthPath = "/src/services/backend-health.js";
    const bannerPath = "/src/components/connection-banner.js";
    const i18nPath = "/src/i18n/i18n.js";
    const spinnerPath =
      "/@id/@awesome.me/webawesome/dist/components/spinner/spinner.js";
    await import(spinnerPath);
    const health = await import(healthPath);
    const { mountConnectionBanner } = await import(bannerPath);
    const { t } = await import(i18nPath);
    health.connectionFailed("api");
    mountConnectionBanner();
    return {
      checking: t("notice.checkingConnection"),
      retry: t("notice.checkConnection"),
      online: t("notice.online"),
    };
  });
  const button = page.locator("connection-banner button");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toContainText(labels.checking);
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  expect(
    (await new AxeBuilder({ page }).include("connection-banner").analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: `e2e/test-results/connection-check-${test.info().project.name}.png`,
  });
  await page.waitForTimeout(1000);
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 2000 });
  await expect(button).toHaveText(labels.retry);
  await button.click();
  await page.evaluate(async () => {
    const path = "/src/services/backend-health.js";
    (await import(path)).connectionSucceeded("api");
  });
  await expect(page.locator("connection-banner")).toContainText(labels.online);
  await expect(button).toBeHidden({ timeout: 500 });
});

test("invitation area collapses after the last link disappears despite whitespace", async ({
  page,
}) => {
  await page.route("**/__access_layout", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html lang="en"><head><title>Local layout test</title><link rel="stylesheet" href="/src/components/site-admin.css"></head><body><main><div id="staff-grant-result" class="site-access-grant">\n <details><summary>Test invitation</summary><p>Test content</p></details>\n </div><h2 id="devices">Team devices</h2></main></body></html>',
    }),
  );
  await page.goto("/__access_layout");
  expect(
    await page
      .locator(".site-access-grant")
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBeLessThan(150);
  await page.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("details")).toHaveAttribute("open", "");
  await page.evaluate(() => document.querySelector("details")?.remove());
  expect(
    await page
      .locator(".site-access-grant")
      .evaluate((node) => node.getBoundingClientRect().height),
  ).toBe(0);
  expect(
    await page
      .locator(".site-access-grant")
      .evaluate((node) => getComputedStyle(node).marginBlockStart),
  ).toBe("0px");
});
