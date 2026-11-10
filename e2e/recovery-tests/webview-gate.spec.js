import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { bindings: [], tasks: [], checks: [], sites: [] } }),
  );
});

const safari =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const invitation =
  "/#enrollment_grant=synthetic-grant&enrollment_token=synthetic-token";

for (const agent of [
  `${safari} Outlook-iOS/9400.0`,
  `${safari} GmailApp`,
  "Mozilla/5.0 (Linux; Android 14; Test Device; wv) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36",
]) {
  test(`webview prevents enrollment and preserves the full invitation: ${agent}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      userAgent: agent,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const mutations = [];
    page.on("request", (request) => {
      if (request.method() === "POST") mutations.push(request.url());
    });
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Clipboard unavailable");
          },
        },
      });
    });
    await page.goto(`${baseURL}${invitation}`);
    await expect(page.locator("#webview-gate")).toBeVisible();
    await expect(page.locator("site-setup")).toHaveCount(0);
    expect(page.url()).toBe(`${baseURL}${invitation}`);
    await page.locator("#webview-copy").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#webview-link")).toBeVisible();
    await expect(page.locator("#webview-link")).toHaveJSProperty(
      "value",
      `${baseURL}${invitation}`,
    );
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
      (await new AxeBuilder({ page }).include("#webview-gate").analyze())
        .violations,
    ).toEqual([]);
    expect(mutations).toEqual([]);
    await context.close();
  });
}

test("copy success preserves invitation credentials without redeeming them", async ({
  page,
}) => {
  await page.addInitScript((agent) => {
    Object.defineProperty(window.navigator, "userAgent", { value: agent });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (/** @type {string} */ value) => {
          /** @type {Window & { __copiedLink?: string }} */ (
            window
          ).__copiedLink = value;
        },
      },
    });
  }, `${safari} Outlook-iOS/9400.0`);
  await page.goto(invitation);
  const original = page.url();
  await expect(page.locator("#webview-gate")).toBeVisible();
  await page.screenshot({
    path: `/tmp/gnp-webview-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.locator("#webview-copy").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          /** @type {Window & { __copiedLink?: string }} */ (window)
            .__copiedLink,
      ),
    )
    .toBe(original);
  await expect(page.locator("#webview-link")).toBeHidden();
  await expect(page.locator("site-setup")).toHaveCount(0);
});

for (const agent of [
  safari,
  safari.replace("Version/17.5", "CriOS/126.0.0.0"),
  "Mozilla/5.0 (Linux; Android 14; Test Device) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36",
]) {
  test(`normal browser retains invitation confirmation: ${agent}`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ userAgent: agent });
    const page = await context.newPage();
    await page.goto(`${baseURL}${invitation}`);
    await expect(page.locator("#enrollment-form")).toBeVisible();
    await expect(page.locator("#webview-gate")).toHaveCount(0);
    await context.close();
  });
}

test("used invitation recovery reloads and enters the saved browser session", async ({
  page,
}) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/app/v1/**", (route) => {
    if (route.request().url().endsWith("/enrollment/redeem")) {
      return route.fulfill({
        status: 409,
        json: { error: "enrollment_already_used" },
      });
    }
    return route.fulfill({
      json: { bindings: [], tasks: [], checks: [], sites: [] },
    });
  });
  await page.goto(invitation);
  await expect(page.locator("#enrollment-form")).toBeVisible();
  await page.evaluate(async () => {
    const dbPath = "/src/db.js";
    const { setSite } = await import(dbPath);
    await setSite("Synthetic site", {
      siteId: "synthetic-site",
      token: "synthetic-token",
      tokenExpiresAt: Date.now() / 1000 + 3600,
    });
    /** @type {Window & { __beforeRecovery?: boolean }} */ (
      window
    ).__beforeRecovery = true;
  });
  await page.locator("#confirm-enrollment").click();
  await expect(page.locator("#enrollment-form [role=alert]")).toBeVisible();
  await page.locator("#enrollment-open-app").click();
  await expect(page.locator("today-view")).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        /** @type {Window & { __beforeRecovery?: boolean }} */ (window)
          .__beforeRecovery,
    ),
  ).toBeUndefined();
  await expect(page.locator("site-setup")).toHaveCount(0);
});
