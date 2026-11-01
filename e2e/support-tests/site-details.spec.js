import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

/** @param {import('@playwright/test').Page} page */
async function setup(page) {
  const site = {
    siteId: "site-details-test",
    name: "Synthetic Site",
    address: {},
    publicContact: {
      email: "public@example.test",
      phone: "415-555-0100",
      phoneExtension: "2",
    },
    siteManagers: [
      {
        personId: "synthetic-person",
        name: "Test Site Manager",
        email: "manager@example.test",
        phone: "415-555-0101",
        canEditPhone: true,
      },
    ],
    cityProgramManagers: [
      {
        name: "Test City Manager",
        department: "Synthetic Department",
        email: "city@example.test",
        phone: "415-555-0102",
        phoneExtension: "3",
      },
    ],
    perimeter: "Synthetic perimeter",
    oversight: {},
    compliance: {},
    letterState: "archived",
    compliancePeriods: /** @type {Array<Record<string, any>>} */ ([]),
    complianceLetters: {
      current: /** @type {Record<string, any> | null} */ (null),
      past: /** @type {Array<Record<string, any>>} */ ([]),
    },
  };
  /** @type {Array<{section: string, values: Record<string, any>}>} */
  const changes = [];
  await page.route("**/v1/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/site-admin")) {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON();
        changes.push(body);
        if (body.section === "publicContact") site.publicContact = body.values;
        if (body.section === "perimeter")
          site.perimeter = body.values.perimeter;
        if (body.section === "siteManagerPhone")
          site.siteManagers[0].phone = body.values.phone;
      }
      await route.fulfill({ json: { site } });
    } else
      await route.fulfill({
        json: {
          site: { siteId: site.siteId, name: site.name },
          checks: [],
          tasks: [],
          sites: [],
          bindings: [],
        },
      });
  });
  await page.route("**/__site_details_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Site details test</title></head><body><main></main><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__site_details_test");
  await page.evaluate(async () => {
    await window.customElements.whenDefined("today-view");
    const dbPath = "/src/db.js";
    const { setSite } = await import(dbPath);
    await setSite("Synthetic Site", {
      siteId: "site-details-test",
      accessLevel: "manager",
      token: "synthetic-token",
      deviceId: "synthetic-device",
    });
    document.querySelector("main")?.remove();
    document.body.append(document.createElement("app-root"));
    const routerPath = "/src/router.js";
    const { navigate } = await import(routerPath);
    navigate("/site-admin");
  });
  await expect(page.locator("site-admin-view h1")).toHaveText(
    t("siteAdmin.title"),
  );
  await expect(page.locator('[data-edit-section="contact"]')).toBeVisible();
  return { site, changes };
}

test("Site contacts are ordered, callable, and accessible on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await setup(page);
  await expect(page.locator("site-admin-view h2").nth(1)).toHaveText(
    t("siteAdmin.contact.title"),
  );
  await expect(page.locator("site-admin-view h2").nth(2)).toHaveText(
    t("siteAdmin.managers.title"),
  );
  await expect(page.locator("site-admin-view h2").nth(3)).toHaveText(
    t("siteAdmin.cityManagers.title"),
  );
  await expect(page.locator("[data-site-managers]")).toContainText(
    t("siteAdmin.managers.help"),
  );
  const city = page.locator("[data-city-managers]");
  await expect(city.locator('a[href^="mailto:"]')).toHaveAttribute(
    "href",
    "mailto:city%40example.test",
  );
  await expect(city.locator('a[href^="tel:"]')).toHaveAttribute(
    "href",
    "tel:4155550102;ext=3",
  );
  await expect(city.locator("button, input, wa-input")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const axe = await new AxeBuilder({ page })
    .include("site-admin-view")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(axe.violations).toEqual([]);
});

test("public contact edits save only public fields and render the new values", async ({
  page,
}) => {
  const { changes } = await setup(page);
  await page.locator('[data-edit-section="contact"]').click();
  await expect(page.locator("#admin-first-name")).toHaveCount(0);
  await page.locator("#admin-phone").locator("input").fill("415-555-0104");
  await page.locator("#admin-phone-extension").locator("input").fill("7");
  await page.locator("#site-admin-save").click();
  await expect(page.locator("site-admin-view")).toContainText("415-555-0104");
  expect(changes[0]).toEqual({
    section: "publicContact",
    values: {
      email: "public@example.test",
      phone: "415-555-0104",
      phoneExtension: "7",
    },
  });
});

test("manager phone and perimeter editors save scoped changes", async ({
  page,
}) => {
  const { changes } = await setup(page);
  await page.locator('[data-edit-section="manager/synthetic-person"]').click();
  await expect(page.locator("site-info-editor")).toContainText(
    "Test Site Manager",
  );
  await expect(page.locator("#admin-email, #admin-first-name")).toHaveCount(0);
  await page.locator("#admin-phone").locator("input").fill("415-555-0105");
  await page.locator("#site-admin-save").click();
  await expect(page.locator("[data-site-managers]")).toContainText(
    "415-555-0105",
  );
  expect(changes[0]).toEqual({
    section: "siteManagerPhone",
    values: { personId: "synthetic-person", phone: "415-555-0105" },
  });
  await page.locator('[data-edit-section="perimeter"]').click();
  await page
    .locator("#admin-perimeter")
    .locator("textarea")
    .fill("Updated synthetic perimeter");
  await page.locator("#site-admin-save").click();
  await expect(page.locator("site-admin-view")).toContainText(
    "Updated synthetic perimeter",
  );
  expect(changes[1]).toEqual({
    section: "perimeter",
    values: { perimeter: "Updated synthetic perimeter" },
  });
});

test("returning to the app refreshes dashboard contact and assignment changes", async ({
  page,
}) => {
  const { site } = await setup(page);
  site.publicContact.phone = "415-555-0109";
  site.cityProgramManagers[0].phone = "415-555-0110";
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(page.locator("site-admin-view")).toContainText("415-555-0109");
  await expect(page.locator("[data-city-managers]")).toContainText(
    "415-555-0110",
  );
});

test("contact drafts survive focus changes and require confirmation before discarding", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-edit-section="contact"]').click();
  const phone = page.locator("#admin-phone").locator("input");
  await phone.fill("415-555-0111");
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(phone).toHaveValue("415-555-0111");
  await page.locator("#site-admin-cancel").click();
  await expect(page.locator("#site-admin-discard-dialog")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include("#site-admin-discard-dialog")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("discard-dialog.png") });
  await page.evaluate(() => document.documentElement.classList.add("wa-dark"));
  await expect(page.locator("#site-admin-keep")).toHaveCSS(
    "color",
    "rgb(237, 237, 237)",
  );
  const darkResults = await new AxeBuilder({ page })
    .include("#site-admin-discard-dialog")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(darkResults.violations).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("discard-dialog-dark.png"),
  });
  await page.locator("#site-admin-keep").click();
  await expect(phone).toHaveValue("415-555-0111");
  await page.locator("#site-admin-cancel").click();
  await page.locator("#site-admin-discard").click();
  await expect(page.locator("site-admin-view")).toBeVisible();
});

test("canonical requirement changes move letters to history while keeping past periods", async ({
  page,
}) => {
  const { site } = await setup(page);
  site.compliance = {
    perimeterChecksRequired: true,
    requiredChecksPerDay: 4,
    periodStart: "2026-10-01",
  };
  site.compliancePeriods = [
    {
      termsVersionId: "v1",
      effectiveStart: "2026-10-01",
      requiredChecksPerDay: 4,
      status: "active",
    },
  ];
  site.complianceLetters.current = {
    effectiveStart: "2026-10-01",
    termsVersionId: "v1",
    url: "https://example.test/synthetic-letter.pdf",
  };
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(page.locator(".site-admin-letter-current a")).toHaveCount(1);
  site.compliance = { perimeterChecksRequired: false };
  site.compliancePeriods[0].status = "past";
  site.compliancePeriods[0].effectiveEnd = "2026-10-27";
  site.complianceLetters.past = [
    { ...site.complianceLetters.current, effectiveEnd: "2026-10-27" },
  ];
  site.complianceLetters.current = null;
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(page.locator("site-admin-view")).toContainText(
    t("siteAdmin.compliance.notRequired"),
  );
  await expect(page.locator(".site-admin-letter-current")).toHaveCount(0);
  await expect(page.locator(".site-admin-letter-row a")).toHaveCount(1);
  await expect(page.locator("[data-compliance-history]")).toContainText(
    t("siteAdmin.compliance.cadence", { count: 4 }),
  );
});

test("a newly generated current letter appears without leaving the screen", async ({
  page,
}) => {
  const { site } = await setup(page);
  site.compliance = {
    perimeterChecksRequired: true,
    requiredChecksPerDay: 3,
    periodStart: "2026-10-01",
  };
  site.letterState = "draft_pending";
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(page.locator("site-admin-view")).toContainText(
    t("admin.letters.pending"),
  );
  site.letterState = "generated";
  site.complianceLetters.current = {
    effectiveStart: "2026-10-01",
    termsVersionId: "generated",
    url: "https://example.test/generated.pdf",
  };
  await expect(page.locator(".site-admin-letter-current a")).toHaveAttribute(
    "href",
    "https://example.test/generated.pdf",
  );
});

test("Site information uses shared rows and padded empty states", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  const { site } = await setup(page);
  site.publicContact.phoneExtension = "";
  site.cityProgramManagers = [];
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(
    page.locator("[data-city-managers] .site-admin-card"),
  ).toContainText(t("siteAdmin.managers.empty"));
  await expect(page.locator("[data-site-managers] dt")).toHaveText([
    t("siteAdmin.contact.name"),
    t("siteAdmin.field.email"),
    t("siteAdmin.field.phone"),
  ]);
  await expect(page.locator("[data-site-managers] button")).toHaveText(
    t("common.edit"),
  );
  await expect(
    page
      .locator("site-admin-view dt")
      .filter({ hasText: t("siteAdmin.field.phoneExtension") }),
  ).toHaveCount(0);
  for (const empty of await page
    .locator(".site-admin-letters .site-admin-empty")
    .all()) {
    expect(
      await empty.evaluate((el) =>
        parseFloat(window.getComputedStyle(el).paddingTop),
      ),
    ).toBeGreaterThanOrEqual(16);
  }
  await page.screenshot({
    path: "/tmp/gn-site-information.png",
    fullPage: true,
  });
});

test("pending letters recover beyond ten attempts and stop polling on completion", async ({
  page,
}) => {
  await page.clock.install();
  const { site } = await setup(page);
  site.letterState = "draft_pending";
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(page.locator("site-admin-view")).toContainText(
    t("admin.letters.pending"),
  );
  // Each tick exceeds the maximum backoff. Wait for the response and render
  // before advancing again so network scheduling cannot collapse the attempts.
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/site-admin"),
    );
    await page.clock.runFor(30000);
    await response;
    await expect(page.locator("site-admin-view")).toContainText(
      t("admin.letters.pending"),
    );
  }
  site.letterState = "generated";
  site.complianceLetters.current = {
    effectiveStart: "2026-10-01",
    url: "https://example.test/delayed.pdf",
  };
  await page.clock.runFor(30000);
  await expect(page.locator(".site-admin-letter-current a")).toHaveAttribute(
    "href",
    "https://example.test/delayed.pdf",
  );
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/site-admin")) requests++;
  });
  await page.clock.runFor(120000);
  expect(requests).toBe(0);
});

test("pending-letter polling survives fetch failures and pauses when hidden or removed", async ({
  page,
}) => {
  await page.clock.install();
  const { site } = await setup(page);
  site.letterState = "draft_pending";
  await page.evaluate(() => window.dispatchEvent(new window.Event("focus")));
  await expect(page.locator("site-admin-view")).toContainText(
    t("admin.letters.pending"),
  );
  let failNext = true;
  await page.route("**/v1/site-admin", (route) => {
    if (failNext) {
      failNext = false;
      return route.abort("failed");
    }
    return route.fallback();
  });
  const failure = page.waitForEvent("requestfailed", (request) =>
    request.url().endsWith("/site-admin"),
  );
  await page.clock.runFor(3000);
  await failure;
  const recovery = page.waitForResponse((response) =>
    response.url().endsWith("/site-admin"),
  );
  await page.clock.runFor(30000);
  await recovery;
  await expect(page.locator("site-admin-view")).toContainText(
    t("admin.letters.pending"),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/site-admin")) requests++;
  });
  await page.clock.runFor(120000);
  expect(requests).toBe(0);
  const resumed = page.waitForResponse((response) =>
    response.url().endsWith("/site-admin"),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await resumed;
  await expect.poll(() => requests).toBe(1);
  await page.locator("site-admin-view").evaluate((el) => el.remove());
  requests = 0;
  await page.clock.runFor(120000);
  expect(requests).toBe(0);
});
