import { test, expect } from "@playwright/test";

/** @param {import("@playwright/test").Page} page */
async function openStoragePage(page) {
  await page.route("**/binding-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Binding storage test</title>",
    }),
  );
  await page.goto("/binding-test");
}

test("a discovery write queued behind sign-out cannot recreate saved sites", async ({
  page,
}) => {
  await openStoragePage(page);
  const result = await page.evaluate(async () => {
    const url = "/src/db.js";
    const db = await import(url);
    const expectedSession = await db.setSite("Synthetic active site", {
      siteId: "active",
      deviceId: "device",
      physicalDeviceId: "physical",
      token: "synthetic-access",
      refreshToken: "synthetic-refresh",
    });
    // Discovery has read/validated the old session. Sign-out queues its clear
    // transaction before discovery opens the write transaction.
    const clearing = db.clearSiteSession();
    const saving = db.saveDiscoveredBindings(
      [
        {
          siteId: "second",
          siteName: "Synthetic second site",
          bindingId: "second-binding",
        },
      ],
      "physical",
      { expectedSession },
    );
    await clearing;
    return {
      saved: await saving,
      current: await db.getSite(),
      sites: await db.listBoundSites(),
    };
  });
  expect(result.saved).toBe(false);
  expect(result.current).toBeUndefined();
  expect(result.sites).toEqual([]);
});

for (const replacement of ["other-site", "same-site-new-session"]) {
  test(`discovery rejects a queued ${replacement} replacement`, async ({
    page,
  }) => {
    await openStoragePage(page);
    const result = await page.evaluate(async (replacement) => {
      const url = "/src/db.js";
      const db = await import(url);
      const meta = {
        siteId: "active",
        deviceId: "device",
        physicalDeviceId: "physical",
      };
      const expectedSession = await db.setSite("Synthetic active site", meta);
      const replacing = db.setSite("Synthetic replacement", {
        ...meta,
        ...(replacement === "other-site"
          ? { siteId: "other", deviceId: "other-device" }
          : {}),
      });
      const saving = db.saveDiscoveredBindings(
        [
          {
            siteId: "late",
            siteName: "Synthetic stale result",
            bindingId: "late-binding",
          },
        ],
        "physical",
        { expectedSession },
      );
      await replacing;
      return { saved: await saving, sites: await db.listBoundSites() };
    }, replacement);
    expect(result.saved).toBe(false);
    expect(
      result.sites.some(
        (/** @type {{siteId: string}} */ site) => site.siteId === "late",
      ),
    ).toBe(false);
  });
}

for (const bindings of [
  [],
  [
    {
      siteId: "live",
      siteName: "Synthetic live site",
      bindingId: "live-binding",
    },
  ],
]) {
  test(`complete discovery removes revoked and expired siblings (${bindings.length} live siblings)`, async ({
    page,
  }) => {
    await openStoragePage(page);
    const result = await page.evaluate(async (bindings) => {
      const url = "/src/db.js";
      const db = await import(url);
      const expectedSession = await db.setSite("Synthetic active site", {
        siteId: "active",
        deviceId: "device",
        physicalDeviceId: "physical",
        token: "synthetic-access",
        refreshToken: "synthetic-refresh",
      });
      await db.saveDiscoveredBindings(
        [
          {
            siteId: "revoked",
            siteName: "Synthetic revoked site",
            bindingId: "revoked-binding",
          },
          {
            siteId: "expired",
            siteName: "Synthetic expired site",
            bindingId: "expired-binding",
          },
        ],
        "physical",
      );
      await db.saveDiscoveredBindings(
        [
          {
            siteId: "unrelated",
            siteName: "Synthetic separate device",
            bindingId: "unrelated-binding",
          },
        ],
        "other-physical",
      );
      const saved = await db.saveDiscoveredBindings(bindings, "physical", {
        expectedSession,
      });
      return {
        saved,
        current: await db.getSite(),
        sites: await db.listBoundSites(),
      };
    }, bindings);
    expect(result.saved).toBe(true);
    expect(
      result.sites
        .map((/** @type {{siteId: string}} */ site) => site.siteId)
        .sort(),
    ).toEqual(
      ["active", "unrelated", ...bindings.map((site) => site.siteId)].sort(),
    );
    expect(result.current.token).toBe("synthetic-access");
    expect(result.current.refreshToken).toBe("synthetic-refresh");
  });
}
