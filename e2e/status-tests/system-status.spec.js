import { t } from "../helpers/i18n.js";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const sampleSite = {
  siteId: "one",
  name: "Example Site",
  counts: {
    submissions: 2,
    checks: 2,
    issues: 1,
    actions: 1,
    deletions: 0,
    duplicates: 1,
  },
  groups: {
    issues: { Graffiti: 1 },
    actions: { task_completed: 1 },
    deletions: {},
  },
  active: true,
  submissionHours: [0, 1, 1],
  analysisHours: [null, 100, 0],
  succeeded: 1,
  failed: 1,
  pending: 0,
  analysis: { state: "red", percent: 50 },
  checks: { finished: 1, unfinished: 1 },
};
const summary = {
  now: "2026-10-24T10:00:00Z",
  start: "2026-10-24T07:00:00Z",
  trackingSince: "2026-10-20T07:00:00Z",
  sites: [sampleSite],
  network: { state: "green", percent: 100 },
  analysis: { state: "red", percent: 50 },
  pending: 0,
  duplicatesAvailable: false,
};
/** @param {import("@playwright/test").Page} page @param {boolean} [supervisor] */
async function setup(page, supervisor = true) {
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path.endsWith("/session"))
      json = {
        role: supervisor ? "compliance-supervisor" : "compliance-manager",
        capabilities: {
          manageAdminUsers: supervisor,
          createEntities: supervisor,
        },
      };
    else if (path.endsWith("/profile")) json = { profile: {} };
    else if (path.endsWith("/system-status")) json = summary;
    else if (path.endsWith("/one/submissions"))
      json = {
        entries: [
          {
            id: "entry",
            at: summary.now,
            checkId: "c",
            artifactId: "a",
            text: "Litter near entrance",
          },
        ],
        cursor: null,
      };
    else if (path.endsWith("/one/duplicates"))
      json = {
        entries: [
          {
            id: "duplicate",
            eventKey: "duplicate",
            at: summary.now,
            taskId: "task",
          },
        ],
        cursor: null,
      };
    else if (path.endsWith("/duplicates/task"))
      json = {
        separated: true,
        pair: [{ text: "New observation" }, { text: "Earlier observation" }],
      };
    else if (path.endsWith("/media/c/a"))
      json = { text: "Litter near entrance" };
    await route.fulfill({ json });
  });
}
test("supervisor menu, status drilldowns, filters and previews", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/sites");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: t("admin.status.menu") }).click();
  await expect(page.locator("#status-title")).toHaveText(
    t("admin.status.title"),
  );
  await expect(page.locator(".status-row")).toHaveCount(8);
  await page.screenshot({
    path: "/tmp/system-status-overview.png",
    fullPage: true,
  });
  await page.locator('a[href="/system-status/checks"]').focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: t("admin.status.unfinished"), exact: true })
    .click();
  await expect(page.locator("[data-filter=unfinished]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".status-site-heading")).toContainText("1");
  await page
    .getByRole("link", { name: t("admin.status.title"), exact: false })
    .click();
  await page.locator('a[href="/system-status/submissions"]').click();
  await page.getByRole("button", { name: /Litter near entrance/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("link", { name: t("admin.status.title"), exact: false })
    .click();
  await page.locator('a[href="/system-status/duplicates"]').click();
  await page.locator("[data-preview]").click();
  await expect(page.getByRole("dialog")).toContainText(
    t("admin.status.separated"),
  );
  await expect(page.getByRole("dialog")).toContainText("Earlier observation");
});
test("manager cannot open status or see its menu item", async ({ page }) => {
  await setup(page, false);
  await page.goto("/system-status");
  await expect(page).toHaveURL(/\/sites$/);
  await expect(page.locator("system-status-view")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: t("admin.status.menu") }),
  ).toHaveCount(0);
});
test("health view is accessible and fits mobile", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/system-status/network");
  await expect(page.locator(".status-site")).toHaveCount(1);
  const results = await new AxeBuilder({ page })
    .include(".status-page")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/system-status-mobile.png",
    fullPage: true,
  });
});

test("health indicators explain their thresholds on hover and focus", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/system-status");
  await expect(page.locator(".status-notice")).toHaveCount(0);
  await expect(page.locator(".status-row-value small")).toHaveCount(0);
  await page.locator("#status-row-network .status-dot").hover();
  const network = page.locator('wa-tooltip[for="status-row-network"]');
  await expect(network).toHaveAttribute("open", "");
  await expect(network).toHaveText(t("admin.status.networkTooltip.green"));
  await page.locator("#status-row-analysis").focus();
  const analysis = page.locator('wa-tooltip[for="status-row-analysis"]');
  await expect(analysis).toHaveAttribute("open", "");
  await expect(analysis).toHaveText(t("admin.status.analysisTooltip.red"));
  await page.keyboard.press("Escape");
  await expect(analysis).not.toHaveAttribute("open", "");
  for (const kind of ["network", "analysis"]) {
    await page.goto(`/system-status/${kind}`);
    await expect(page.locator(".status-page")).toContainText(
      t("admin.status.today"),
    );
  }
});

test("renews cached thumbnail URLs without discarding loaded submissions", async ({
  page,
}) => {
  await setup(page);
  let lists = 0;
  await page.route("**/one/submissions", (route) => {
    lists++;
    return route.fulfill({
      json: {
        entries: [
          {
            id: "photo",
            checkId: "c",
            artifactId: "a",
            at: summary.now,
            url: "/old-thumbnail.svg",
            urlExpiresAt: new Date(Date.now() + 30000).toISOString(),
          },
        ],
        cursor: null,
      },
    });
  });
  await page.route("**/*thumbnail.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    }),
  );
  await page.route("**/media/c/a?thumbnail=true", (route) =>
    route.fulfill({
      json: {
        url: "/renewed-thumbnail.svg",
        urlExpiresAt: new Date(Date.now() + 300000).toISOString(),
        checkId: "c",
        artifactId: "a",
      },
    }),
  );
  await page.goto("/system-status/submissions");
  await expect(page.locator(".status-tile img")).toHaveAttribute(
    "src",
    "/old-thumbnail.svg",
  );
  await page.locator("#status-refresh").click();
  await expect(page.locator(".status-tile img")).toHaveAttribute(
    "src",
    "/renewed-thumbnail.svg",
  );
  expect(lists).toBe(1);
});

for (const obsoleteFails of [false, true]) {
  test(`refresh ignores obsolete entry ${obsoleteFails ? "errors" : "responses"}`, async ({
    page,
  }) => {
    await setup(page);
    let refreshes = 0;
    await page.route("**/admin/v1/system-status", (route) =>
      route.fulfill({
        json: {
          ...summary,
          sites: [
            {
              ...sampleSite,
              counts: {
                ...sampleSite.counts,
                submissions: ++refreshes === 1 ? 2 : 3,
              },
            },
          ],
        },
      }),
    );
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    let lists = 0;
    await page.route("**/one/submissions", async (route) => {
      const first = ++lists === 1;
      if (first) await gate;
      if (first && obsoleteFails)
        return route.fulfill({ status: 500, json: { error: "old failure" } });
      return route.fulfill({
        json: {
          entries: [
            {
              id: first ? "old" : "new",
              at: summary.now,
              text: first ? "Stale submission" : "Fresh submission",
            },
          ],
          cursor: null,
        },
      });
    });
    await page.goto("/system-status/submissions");
    await expect.poll(() => lists).toBe(1);
    await page.locator("#status-refresh").click();
    await expect(page.locator(".status-filmstrip")).toContainText(
      "Fresh submission",
    );
    release();
    // Wait for the obsolete request to settle, then check that no stale cache
    // or error can replace the new generation's content.
    await page.waitForResponse((response) =>
      response.url().endsWith("/one/submissions"),
    );
    await page.locator("#status-refresh").click();
    await expect(page.locator(".status-filmstrip")).toContainText(
      "Fresh submission",
    );
    await expect(page.locator(".status-filmstrip")).not.toContainText(
      "Stale submission",
    );
    await expect(page.locator("[data-load]")).toHaveCount(0);
  });
}
