import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** @param {import('@playwright/test').Page} page */
async function blankPage(page) {
  await page.route("**/session-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en" class="wa-dark wa-theme-default wa-palette-default wa-brand-blue"><head><title>Session test</title><link rel="stylesheet" href="/src/styles/tokens.css"><link rel="stylesheet" href="/src/styles/base.css"></head><body></body></html>',
    }),
  );
  await page.goto("/session-test");
}

test("two tabs waking after expiry spend only one rotating refresh token", async ({
  page,
  context,
}) => {
  let refreshes = 0;
  await context.route("**/v1/devices/token:refresh", async (route) => {
    refreshes += 1;
    expect(route.request().postDataJSON().refreshToken).toBe("refresh-old");
    await route.fulfill({
      json: {
        deviceId: "device",
        site: { siteId: "site", name: "Site" },
        accessLevel: "general",
        token: "access-new",
        refreshToken: "refresh-new",
        expiresIn: 900,
        tokenGeneration: 2,
      },
    });
  });
  await context.route("**/v1/checks*", (route) => {
    expect(route.request().headers().authorization).toBe("Bearer access-new");
    return route.fulfill({ json: { checks: [] } });
  });
  await blankPage(page);
  await page.evaluate(async () => {
    const url = "/src/db.js";
    const { setSite } = await import(url);
    await setSite("Site", {
      siteId: "site",
      deviceId: "device",
      token: "access-old",
      refreshToken: "refresh-old",
      tokenExpiresAt: "2020-01-01T00:00:00Z",
    });
  });
  const second = await context.newPage();
  await blankPage(second);
  // Hold the origin-wide lock until both independent module instances have
  // read the expired binding and queued their rotation.
  await page.evaluate(() => {
    const state = /** @type {any} */ (window);
    state.sessionTestRelease = null;
    state.sessionTestLock = window.navigator.locks.request(
      "gnp:refresh:site",
      () =>
        new Promise((resolve) => {
          state.sessionTestRelease = resolve;
        }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(/** @type {any} */ (window).sessionTestRelease),
      ),
    )
    .toBe(true);
  for (const tab of [page, second]) {
    await tab.evaluate(async () => {
      const url = "/src/services/api.js";
      const { listChecks } = await import(url);
      /** @type {any} */ (window).sessionTestRequest = listChecks();
    });
  }
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.navigator.locks.query()).pending?.length,
      ),
    )
    .toBe(2);
  await page.evaluate(() => /** @type {any} */ (window).sessionTestRelease());
  await Promise.all(
    [page, second].map((tab) =>
      tab.evaluate(() => /** @type {any} */ (window).sessionTestRequest),
    ),
  );
  expect(refreshes).toBe(1);
});

test("a bookmark restores the saved session after every app tab is closed", async ({
  page,
  context,
}) => {
  await context.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [], bindings: [] } }),
  );
  await context.route("**/app/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [], bindings: [] } }),
  );
  await blankPage(page);
  await page.evaluate(async () => {
    const url = "/src/db.js";
    const { setSite } = await import(url);
    await setSite("Site", {
      siteId: "site",
      deviceId: "device",
      token: "access",
      refreshToken: "refresh",
      tokenExpiresAt: "2099-01-01T00:00:00Z",
    });
  });
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto("/#login=1");
  await expect(reopened.locator("app-root .app")).toBeVisible();
  await expect(reopened.locator("site-setup")).toHaveCount(0);
});

test("a fresh standalone app redeems its copied HttpOnly cookie without a special launch URL", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window.navigator, "standalone", { value: true }),
  );
  await context.addCookies([
    {
      name: "__Secure-gnp-handoff",
      value: "grant.synthetic-token",
      domain: "127.0.0.1",
      path: "/app/v1/session-handoff",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [], bindings: [] } }),
  );
  await page.route("**/app/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [], bindings: [] } }),
  );
  let redemptions = 0;
  await page.route("**/app/v1/session-handoff/redeem", async (route) => {
    redemptions += 1;
    expect(route.request().postDataJSON()).toEqual({});
    expect(route.request().headers().cookie).toContain(
      "__Secure-gnp-handoff=grant.synthetic-token",
    );
    await route.fulfill({
      headers: {
        "set-cookie":
          "__Secure-gnp-handoff=; Path=/app/v1/session-handoff; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
      },
      json: {
        deviceId: "installed-device",
        site: { siteId: "site", name: "Site" },
        accessLevel: "general",
        token: "installed-access",
        refreshToken: "installed-refresh",
        expiresIn: 900,
        tokenGeneration: 1,
      },
    });
  });
  await page.goto("/");
  await expect(page.locator("app-root .app")).toBeVisible();
  await expect(page.locator("site-setup")).toHaveCount(0);
  expect(redemptions).toBe(1);
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "__Secure-gnp-handoff",
    ),
  ).toBe(false);
  await page.reload();
  await expect(page.locator("app-root .app")).toBeVisible();
  expect(redemptions).toBe(1);
});

test("Safari prepares a path-scoped HttpOnly install cookie before offering installation", async ({
  page,
  context,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window.navigator, "userAgent", {
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1",
    }),
  );
  await page.route("**/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [], bindings: [] } }),
  );
  await page.route("**/app/v1/**", (route) =>
    route.fulfill({ json: { checks: [], tasks: [], sites: [], bindings: [] } }),
  );
  await page.route("**/app/v1/session-handoff", (route) =>
    route.fulfill({
      headers: {
        "set-cookie":
          "__Secure-gnp-handoff=grant.synthetic-token; Path=/app/v1/session-handoff; Max-Age=604800; Secure; HttpOnly; SameSite=Strict",
      },
      json: {
        grantId: "grant",
        token: "synthetic-token",
        expiresAt: new Date(Date.now() + 604800000).toISOString(),
        startUrl: "/#handoff_grant=grant&handoff_token=synthetic-token",
      },
    }),
  );
  await blankPage(page);
  await page.evaluate(async () => {
    const url = "/src/db.js";
    const { setSite } = await import(url);
    await setSite("Site", {
      siteId: "site",
      deviceId: "device",
      token: "access",
      refreshToken: "refresh",
      tokenExpiresAt: "2099-01-01T00:00:00Z",
    });
  });
  await page.goto("/");
  await expect
    .poll(
      async () =>
        (await context.cookies()).find(
          (cookie) => cookie.name === "__Secure-gnp-handoff",
        )?.httpOnly,
    )
    .toBe(true);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    /^blob:/,
  );
  expect(await page.evaluate(() => document.cookie)).not.toContain(
    "synthetic-token",
  );
});

test("QR modules and finder corners stay black and scannable in both themes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/app/v1/manager/device-bindings", (route) =>
    route.fulfill({ json: { bindings: [] } }),
  );
  await page.route("**/app/v1/manager/staff-grants/current", (route) =>
    route.fulfill({
      json: {
        grants: [],
      },
    }),
  );
  await page.route("**/app/v1/manager/staff-grants", (route) =>
    route.fulfill({
      status: 201,
      json: {
        grant: {
          grantId: "grant",
          label: "Phone",
          status: "pending",
          accessLevel: "general",
          expiresAt: "2099-01-01T00:00:00Z",
        },
        enrollmentUrl:
          "https://example.org/#enrollment_grant=test&enrollment_token=synthetic",
      },
    }),
  );
  await blankPage(page);
  await page.evaluate(async () => {
    const mainUrl = "/src/main.js";
    await import(mainUrl);
    const dbUrl = "/src/db.js";
    const { setSite } = await import(dbUrl);
    await setSite("Site", {
      siteId: "site",
      deviceId: "device",
      accessLevel: "manager",
      token: "synthetic",
      refreshToken: "synthetic",
      tokenExpiresAt: "2099-01-01T00:00:00Z",
    });
    const componentUrl = "/src/components/site-admin.js";
    await import(componentUrl);
    document.body.append(document.createElement("site-access-view"));
  });
  await page.locator("#staff-device-label input").fill("Phone");
  await page.locator('#staff-grant-form button[type="submit"]').click();
  const details = page.locator(".site-access-ready");
  await expect(details).toBeVisible();
  await details.locator("summary").focus();
  if (
    !(await details.evaluate(
      (element) => /** @type {HTMLDetailsElement} */ (element).open,
    ))
  ) {
    // Keyboard-open the disclosure so the QR is visible.
    await page.keyboard.press("Enter");
  }
  const qr = page.locator("wa-qr-code");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("wa-dark", theme === "dark");
      document.documentElement.classList.toggle("wa-light", theme === "light");
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect(qr).toBeVisible();
    const shareButton = details.locator("[data-share-grant]");
    const cancelButton = details.locator("[data-cancel-staff-grant]");
    const shareBox = await shareButton.boundingBox();
    const cancelBox = await cancelButton.boundingBox();
    if (!shareBox || !cancelBox)
      throw new Error("Enrollment actions are not visible");
    expect(cancelBox.y - (shareBox.y + shareBox.height)).toBeGreaterThanOrEqual(
      8,
    );
    await expect(cancelButton).toHaveClass(/site-access-cancel/);
    await expect(shareButton).toHaveClass(/btn-ink/);
    const qrBounds = await qr.boundingBox();
    const canvasBounds = await qr.locator("canvas").boundingBox();
    if (!qrBounds || !canvasBounds) throw new Error("QR layout is not visible");
    expect(qrBounds.width).toBeCloseTo(qrBounds.height, 0);
    expect(
      Math.abs(
        canvasBounds.x +
          canvasBounds.width / 2 -
          (qrBounds.x + qrBounds.width / 2),
      ),
    ).toBeLessThan(1);
    expect(
      Math.abs(
        canvasBounds.y +
          canvasBounds.height / 2 -
          (qrBounds.y + qrBounds.height / 2),
      ),
    ).toBeLessThan(1);

    await expect
      .poll(() =>
        cancelButton.evaluate((element) => {
          const style = window.getComputedStyle(element);
          return style.color === style.borderTopColor;
        }),
      )
      .toBe(true);

    await expect
      .poll(() =>
        qr.evaluate((element) => {
          const canvas = element.shadowRoot?.querySelector("canvas");
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) return null;
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          let otherInk = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 250) continue;
            if (data[i] < 5 && data[i + 1] < 5 && data[i + 2] < 5) ink += 1;
            else if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250)
              otherInk += 1;
          }
          return {
            black: ink > 1000,
            otherInk,
            color: window.getComputedStyle(element).color,
            background: window.getComputedStyle(element).backgroundColor,
          };
        }),
      )
      .toEqual({
        black: true,
        otherInk: 0,
        color: "rgb(0, 0, 0)",
        background: "rgb(255, 255, 255)",
      });
    await page.screenshot({
      path: test.info().outputPath(`qr-${theme}.png`),
      fullPage: true,
    });
  }
  await expect(qr.locator("canvas")).toHaveAttribute("aria-label", /Phone/);
  const headerBox = await page.locator(".site-admin-header").boundingBox();
  const cardBox = await details.boundingBox();
  if (!headerBox || !cardBox) throw new Error("Enrollment card is not visible");
  expect(cardBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
  expect(cardBox.y).toBeLessThanOrEqual(headerBox.y + headerBox.height + 9);
  const accessibility = await new AxeBuilder({ page })
    .include(".site-access-ready")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 320, height: 852 });
  const narrowPanel = await qr.boundingBox();
  const narrowCanvas = await qr.locator("canvas").boundingBox();
  if (!narrowPanel || !narrowCanvas)
    throw new Error("Narrow QR is not visible");
  expect(narrowCanvas.x).toBeGreaterThanOrEqual(narrowPanel.x + 11);
  expect(narrowCanvas.x + narrowCanvas.width).toBeLessThanOrEqual(
    narrowPanel.x + narrowPanel.width - 11,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("one device exposes labeled sessions and one revoke control", async ({
  page,
}) => {
  await blankPage(page);
  const labels = await page.evaluate(async () => {
    const componentUrl = "/src/components/site-access-devices.js";
    const { deviceRow } = await import(componentUrl);
    const i18nUrl = "/src/i18n/i18n.js";
    const { t } = await import(i18nUrl);
    document.body.innerHTML = deviceRow({
      bindingId: "bob",
      label: "Bob's phone",
      accessLevel: "general",
      status: "active",
      lastSeenAt: "2026-10-27T12:00:00Z",
      sessions: [
        {
          kind: "browser",
          status: "active",
          lastSeenAt: "2026-10-27T12:00:00Z",
        },
        {
          kind: "home_screen",
          status: "active",
          lastSeenAt: "2026-10-27T12:00:00Z",
        },
      ],
    });
    return {
      browser: t("access.session.browser"),
      home: t("access.session.homeScreen"),
      revoke: t("access.revoke"),
    };
  });
  await expect(page.locator(".site-access-device")).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Bob's phone" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: labels.revoke })).toHaveCount(
    1,
  );
  await page.locator(".site-access-sessions summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-session-kind="browser"] strong')).toHaveText(
    labels.browser,
  );
  await expect(
    page.locator('[data-session-kind="home_screen"] strong'),
  ).toHaveText(labels.home);
  await expect(page.locator('[data-revoke-team-device="bob"]')).toBeVisible();
});

test("mobile access header stays at the top and device actions stack above sessions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const sessions = [
    { kind: "browser", status: "active", lastSeenAt: "2026-10-27T12:00:00Z" },
    {
      kind: "home_screen",
      status: "active",
      lastSeenAt: "2026-10-27T12:00:00Z",
    },
  ];
  await page.route("**/app/v1/manager/device-bindings", (route) =>
    route.fulfill({
      json: {
        bindings: [
          {
            bindingId: "jane",
            label: "Jane's phone",
            status: "active",
            accessLevel: "general",
            sessions,
            lastSeenAt: "2026-10-27T12:00:00Z",
          },
          {
            bindingId: "long",
            label: "A very long device name for the mobile layout check",
            status: "active",
            accessLevel: "general",
            sessions,
          },
        ],
      },
    }),
  );
  await page.route("**/app/v1/manager/staff-grants/current", (route) =>
    route.fulfill({
      json: {
        grants: [
          {
            grantId: "older",
            label: "Harry",
            status: "pending",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        ],
      },
    }),
  );
  await blankPage(page);
  await page.evaluate(async () => {
    const mainUrl = "/src/main.js";
    await import(mainUrl);
    const dbUrl = "/src/db.js";
    const { setSite } = await import(dbUrl);
    await setSite("Site", {
      siteId: "site",
      deviceId: "device",
      accessLevel: "manager",
      token: "synthetic",
      refreshToken: "synthetic",
      tokenExpiresAt: "2099-01-01T00:00:00Z",
    });
    const componentUrl = "/src/components/site-admin.js";
    await import(componentUrl);
    const shell = document.createElement("div");
    shell.className = "app--chromeless";
    shell.innerHTML =
      '<main class="app__main"><site-access-view></site-access-view></main>';
    document.body.append(shell);
  });
  const devices = page.locator(".site-access-device");
  await expect(devices).toHaveCount(2);
  const older = page.locator('[data-grant-id="older"]');
  const expiry = await older.locator(":scope > p").boundingBox();
  const cancel = await older.locator("[data-cancel-staff-grant]").boundingBox();
  if (!expiry || !cancel) throw new Error("Existing invitation is not visible");
  expect(cancel.y - expiry.y - expiry.height).toBeGreaterThanOrEqual(16);

  for (const width of [393, 320]) {
    await page.setViewportSize({ width, height: 852 });
    for (const device of await devices.all()) {
      const details = device.locator(".site-access-sessions");
      await details.locator("summary").focus();
      if (
        !(await details.evaluate(
          (element) => /** @type {HTMLDetailsElement} */ (element).open,
        ))
      )
        await page.keyboard.press("Enter");
      const info = await device.locator(":scope > div").boundingBox();
      const revoke = await device
        .locator("button[data-revoke-team-device]")
        .boundingBox();
      const sessionBox = await details.boundingBox();
      if (!info || !revoke || !sessionBox)
        throw new Error("Device layout is not visible");
      expect(revoke.y).toBeGreaterThanOrEqual(info.y + info.height);
      expect(sessionBox.y).toBeGreaterThanOrEqual(revoke.y + revoke.height);
      expect(sessionBox.width).toBeCloseTo(info.width, 0);
    }
    await page.evaluate(() => window.scrollTo(0, 400));
    const header = page.locator(".site-admin-header");
    await expect
      .poll(async () => Math.round((await header.boundingBox())?.y ?? -1))
      .toBe(0);
    expect(
      await header.evaluate(
        (element) => window.getComputedStyle(element).backgroundColor,
      ),
    ).not.toMatch(/rgba\(/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`access-${width}.png`),
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page })
      .include(".site-access-device")
      .include(".site-admin-header")
      .analyze();
    expect(accessibility.violations).toEqual([]);
  }
});
