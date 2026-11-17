import { test, expect } from "../helpers/recovery-test.js";

/** @typedef {Window & { __beforeRecovery?: boolean }} TestWindow */

test.beforeEach(async ({ context }) => {
  await context.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await context.route("**/app/v1/device-bindings", (route) =>
    route.fulfill({ json: { bindings: [] } }),
  );
  await context.route("**/v1/site", (route) =>
    route.fulfill({
      json: { site: { siteId: "synthetic-site", name: "Synthetic site" } },
    }),
  );
  await context.route("**/v1/provider-sites", (route) =>
    route.fulfill({ json: { sites: [] } }),
  );
  await context.route("**/v1/guidance/pending", (route) =>
    route.fulfill({ json: { guidance: [] } }),
  );
  await context.route("**/app/v1/session-handoff", (route) =>
    route.fulfill({
      json: {
        grantId: "synthetic-handoff",
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        startUrl:
          "/#handoff_grant=synthetic-handoff&handoff_token=synthetic-token",
      },
    }),
  );
  await context.route("**/v1/home?**", (route) =>
    route.fulfill({
      json: {
        checks: { ok: true, items: [] },
        tasks: Object.fromEntries(
          ["open", "in_progress", "completing", "completed"].map((status) => [
            status,
            { ok: true, items: [] },
          ]),
        ),
        loadedAt: new Date().toISOString(),
      },
    }),
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
  test(`webview warning allows deliberate enrollment: ${agent}`, async ({
    page,
  }) => {
    await page.addInitScript((agent) => {
      Object.defineProperty(window.navigator, "userAgent", { value: agent });
    }, agent);
    let redemptions = 0;
    await page.route("**/app/v1/enrollment/redeem", (route) => {
      redemptions++;
      return route.fulfill({
        status: 409,
        json: { error: "enrollment_already_used" },
      });
    });
    await page.goto(invitation);
    await expect(page.locator("#enrollment-form")).toBeVisible();
    await expect(page.locator(".webview-banner")).toBeVisible();
    await expect(page.locator("#webview-gate")).toHaveCount(0);
    expect(redemptions).toBe(0);
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    expect(
      (await new AxeBuilder({ page }).include(".webview-banner").analyze())
        .violations,
    ).toEqual([]);
    await page.locator(".webview-banner__close").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".webview-banner")).toHaveCount(0);
    await expect(page.locator("#confirm-enrollment")).toBeEnabled();
    await page.locator("#confirm-enrollment").click();
    await expect.poll(() => redemptions).toBe(1);
  });
}

for (const agent of [
  safari,
  safari.replace("Version/17.5", "CriOS/126.0.0.0"),
  "Mozilla/5.0 (Linux; Android 14; Test Device) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36",
]) {
  test.describe(`normal browser: ${agent}`, () => {
    // Use the managed context so API mocks and device emulation also apply.
    test.use({ userAgent: agent });
    test("retains invitation confirmation", async ({ page }) => {
      await page.goto(invitation);
      await expect(page.locator("#enrollment-form")).toBeVisible();
      await expect(page.locator(".webview-banner")).toHaveCount(0);
    });
  });
}

test("used invitation recovery reloads and enters the saved browser session", async ({
  page,
}) => {
  await page.route("**/app/v1/enrollment/redeem", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "enrollment_already_used" },
    }),
  );
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
    /** @type {TestWindow} */ (window).__beforeRecovery = true;
  });
  await page.locator("#confirm-enrollment").click();
  await expect(page.locator("#enrollment-form [role=alert]")).toBeVisible();
  const homeLoaded = page.waitForResponse("**/v1/home?**");
  await page.locator("#enrollment-open-app").click();
  expect((await homeLoaded).ok()).toBe(true);
  await expect(page.locator("today-view")).toBeVisible();
  expect(
    await page.evaluate(
      () => /** @type {TestWindow} */ (window).__beforeRecovery,
    ),
  ).toBeUndefined();
  await expect(page.locator("site-setup")).toHaveCount(0);
});
