import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";

test("opening an enrollment link does not consume it; keyboard confirmation submits once", async ({
  page,
}) => {
  /** @type {Array<Record<string, unknown>>} */
  const attempts = [];
  await page.route("**/app/v1/enrollment/redeem", async (route) => {
    attempts.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: "enrollment_already_used", requestId: "test-reference" },
    });
  });
  await page.goto("/#enrollment_grant=test-grant&enrollment_token=test-secret");
  const confirm = page.locator("#confirm-enrollment");
  await expect(confirm).toBeVisible();
  expect(attempts).toHaveLength(0);
  await expect(page).not.toHaveURL(/test-secret/);
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(t("setup.enrollment.used"));
  expect(attempts).toEqual([{ grantId: "test-grant", token: "test-secret" }]);
  await expect(
    page.getByText(
      t("setup.enrollment.supportReference", { reference: "test-reference" }),
    ),
  ).toBeVisible();
});

test("manual enrollment requires a code and explicit submission", async ({
  page,
}) => {
  /** @type {Array<Record<string, unknown>>} */
  const attempts = [];
  await page.route("**/app/v1/enrollment/redeem", async (route) => {
    attempts.push(route.request().postDataJSON());
    await route.fulfill({ status: 410, json: { error: "enrollment_expired" } });
  });
  await page.route("**/site-code", (route) =>
    route.fulfill({ json: { code: "012345", enrollment: true } }),
  );
  await page.goto("/#login=1");
  const input = page.locator("#code-input input").first();
  await expect(input).toBeVisible();
  expect(attempts).toHaveLength(0);
  await input.pressSequentially("012345");
  expect(attempts).toHaveLength(0);
  await page.locator("#continue").click();
  await expect(page.getByRole("alert")).toHaveText(
    t("setup.enrollment.expired"),
  );
  expect(attempts).toEqual([{ code: "012345" }]);
});

for (const manager of [true, false]) {
  test(`saved code login survives reload (manager: ${manager})`, async ({
    page,
  }) => {
    let redemptions = 0;
    await page.route("**/v1/**", (route) => route.fulfill({ json: {} }));
    await page.route("**/app/v1/**", (route) => route.fulfill({ json: {} }));
    await page.route("**/site-code", (route) =>
      route.fulfill({
        json: manager
          ? { code: "A1B2C3", enrollment: true }
          : {
              code: "A1B2C3",
              providerSite: {
                id: "site-1",
                siteId: "site-1",
                name: "Test Site",
              },
            },
      }),
    );
    const session = {
      deviceId: "test-device",
      bindingId: "test-binding",
      physicalDeviceId: "test-physical",
      site: { siteId: "site-1", name: "Test Site" },
      token: "test-token",
      refreshToken: "test-refresh",
      expiresIn: 3600,
      tokenGeneration: 1,
      accessLevel: "manager",
      bindings: [],
    };
    await page.route(
      manager ? "**/app/v1/enrollment/redeem" : "**/v1/devices",
      (route) => {
        redemptions += 1;
        return route.fulfill({ status: 201, json: session });
      },
    );
    await page.goto("/?theme=dark#login=1");
    await page.locator("#code-input input").first().pressSequentially("A1B2C3");
    await page.locator("#continue").click();
    await expect(page.locator("site-setup")).toHaveCount(0);
    await expect(page).not.toHaveURL(/login=1/);
    await page.reload();
    await expect(page.locator("app-root main")).toBeVisible();
    await expect(page.locator("site-setup")).toHaveCount(0);
    expect(redemptions).toBe(1);
  });
}
