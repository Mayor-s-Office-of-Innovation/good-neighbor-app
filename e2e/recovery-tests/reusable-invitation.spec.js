import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";

const invitation =
  "/#enrollment_grant=synthetic-grant&enrollment_token=synthetic-invitation";

/** @param {import('@playwright/test').Page} page */
async function mockApp(page) {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/v1/**", (route) =>
    route.fulfill({
      json: {
        site: { siteId: "synthetic-site", name: "Synthetic Site" },
        bindings: [],
        tasks: [],
        checks: [],
        sites: [],
      },
    }),
  );
}

/** @param {number} number */
function session(number) {
  return {
    enrollmentGrantId: "synthetic-grant",
    deviceId: `synthetic-device-${number}`,
    bindingId: `synthetic-device-${number}`,
    physicalDeviceId: `synthetic-physical-${number}`,
    site: { siteId: "synthetic-site", name: "Synthetic Site" },
    token: `synthetic-token-${number}`,
    refreshToken: `synthetic-refresh-${number}`,
    expiresIn: 3600,
    tokenGeneration: 1,
    accessLevel: "manager",
    bindings: [],
  };
}

test("email webview and normal browser can enroll with the same invitation", async ({
  browser,
  baseURL,
}) => {
  const webview = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile Outlook-iOS/9400.0",
  });
  const normal = await browser.newContext();
  let redemptions = 0;
  try {
    for (const context of [webview, normal]) {
      const page = await context.newPage();
      await mockApp(page);
      await page.route("**/app/v1/enrollment/redeem", (route) =>
        route.fulfill({ status: 201, json: session(++redemptions) }),
      );
      await page.goto(`${baseURL}${invitation}`);
      await expect(page.locator("#confirm-enrollment")).toBeVisible();
      expect(redemptions).toBe(context === webview ? 0 : 1);
      await page.locator("#confirm-enrollment").click();
      await expect(page.locator("today-view")).toBeVisible();
    }
    expect(redemptions).toBe(2);
    await webview.pages()[0].reload();
    await expect(webview.pages()[0].locator("today-view")).toBeVisible();
    expect(redemptions).toBe(2);
  } finally {
    await webview.close();
    await normal.close();
  }
});

test("retry after a lost response succeeds, and reopening the link resumes saved access", async ({
  page,
}) => {
  await mockApp(page);
  let redemptions = 0;
  await page.route("**/app/v1/enrollment/redeem", (route) => {
    redemptions++;
    return redemptions === 1
      ? route.abort("failed")
      : route.fulfill({ status: 201, json: session(redemptions) });
  });
  await page.goto(invitation);
  await page.locator("#confirm-enrollment").click();
  await expect(page.locator("#enrollment-form [role=alert]")).toHaveText(
    t("setup.enrollment.failed"),
  );
  await page.locator("#confirm-enrollment").click();
  await expect(page.locator("today-view")).toBeVisible();
  expect(redemptions).toBe(2);
  await page.goto(invitation);
  await expect(page.locator("today-view")).toBeVisible();
  await expect(page.locator("site-setup")).toHaveCount(0);
  expect(redemptions).toBe(2);
});

test("revoked saved access leaves an explicit invitation usable without an auth dialog trap", async ({
  page,
}) => {
  await mockApp(page);
  let redemptions = 0;
  let revoked = false;
  let probes = 0;
  await page.route("**/v1/site", (route) => {
    if (revoked) probes++;
    return route.fulfill({
      status: revoked ? 403 : 200,
      json: revoked
        ? { error: "access_revoked" }
        : { site: { siteId: "synthetic-site", name: "Synthetic Site" } },
    });
  });
  await page.route("**/app/v1/enrollment/redeem", (route) => {
    revoked = false;
    return route.fulfill({ status: 201, json: session(++redemptions) });
  });
  await page.goto(invitation);
  await page.locator("#confirm-enrollment").click();
  await expect(page.locator("today-view")).toBeVisible();
  revoked = true;
  await page.goto(invitation);
  await expect(page.locator("#confirm-enrollment")).toBeEnabled();
  // Wait until the saved-session probe has completed, then operate normally.
  await expect.poll(() => probes).toBe(1);
  await expect(page.locator("#conn-auth-dialog")).not.toBeVisible();
  await page.locator("#confirm-enrollment").click();
  await expect(page.locator("today-view")).toBeVisible();
  expect(redemptions).toBe(2);
});
