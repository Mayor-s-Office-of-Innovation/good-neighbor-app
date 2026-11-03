import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

/** @param {import("@playwright/test").Page} page */
async function setup(page, supervisor = true) {
  const providers = [
    { providerId: "z", name: "Zebra Test Provider", status: "active" },
    { providerId: "a", name: "Alpha Test Provider", status: "active" },
  ];
  const program = {
    programId: "p",
    providerId: "a",
    name: "Current Test Program",
    status: "active",
    updatedAt: "v1",
  };
  const sites = ["one", "two"].map((id) => ({
    siteId: id,
    sk: "#META",
    name: `Test Site ${id}`,
    status: "active",
    providerId: "a",
    leadProgramId: "p",
    programName: "Stale Test Program",
    updatedAt: "v1",
    deliberate311ProductionEnabled: true,
    oversight: { managingCityDepartment: id },
  }));
  /** @type {Array<{path: string, body: any}>} */
  const writes = [];
  await page.addInitScript(() => {
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG = {
      apiBase: window.location.origin,
      localDebugAdmin: true,
    };
  });
  await page.route("http://127.0.0.1:5176/config.js", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.route("**/admin/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== "GET")
      writes.push({ path, body: route.request().postDataJSON() });
    let json = {};
    if (path.endsWith("/session"))
      json = {
        role: supervisor ? "compliance-supervisor" : "compliance-manager",
        capabilities: { createEntities: supervisor },
      };
    else if (path === "/admin/v1/providers")
      json = { providers, sites: sites.map((s) => ({ items: [s] })) };
    else if (path === "/admin/v1/programs")
      json =
        method === "POST"
          ? { program: { ...program, ...route.request().postDataJSON() } }
          : { programs: [program] };
    else if (path === "/admin/v1/programs/p") {
      if (method === "PATCH")
        Object.assign(program, route.request().postDataJSON(), {
          updatedAt: "v2",
        });
      json = { program, users: [], sites: [] };
    } else if (/\/sites\/[^/]+\/deliberate-311$/.test(path)) {
      const record = sites.find((s) => s.siteId === path.split("/").at(-2));
      Object.assign(record || {}, route.request().postDataJSON(), {
        updatedAt: "v2",
      });
      json = { site: record };
    } else if (/\/sites\/[^/]+$/.test(path))
      json = {
        items: [sites.find((s) => s.siteId === path.split("/").at(-1))],
        permissions: { canEdit: true },
      };
    else if (path.endsWith("/oversight-options"))
      json = { departments: [], systemsOfCare: [] };
    else if (path.endsWith("/people")) json = { people: [] };
    else
      json = {
        managers: [],
        memberships: [],
        grants: [],
        devices: [],
        users: [],
      };
    await route.fulfill({ json });
  });
  return { writes, sites };
}

test("311 edits use keyboard, survive filters, warn on navigation, and save", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto("/sites");
  const checkbox = page.locator('[data-site-311="one"]');
  await expect(checkbox).toBeVisible();
  await expect(checkbox).toHaveJSProperty("checked", true);
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toHaveJSProperty("checked", false);
  await expect(page.locator("[data-save-311]")).toBeEnabled();
  expect(writes).toHaveLength(0);
  await page
    .locator('#site-directory-filters wa-select[name="department"]')
    .click();
  await page
    .locator(
      '#site-directory-filters wa-select[name="department"] wa-option[value="two"]',
    )
    .click();
  await expect(page.locator('[data-site-311="one"]')).toHaveCount(0);
  await expect(page.locator("[data-save-311]")).toBeVisible();
  await page.locator('a[href="/sites/new"]').click();
  await expect(page.locator("#site-unsaved-dialog")).toBeVisible();
  await page.locator('#site-unsaved-dialog button[value="keep"]').click();
  await page.locator("[data-save-311]").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-save-311]")).toHaveCount(0);
  expect(writes).toEqual([
    {
      path: "/admin/v1/sites/one/deliberate-311",
      body: { deliberate311ProductionEnabled: false, expectedUpdatedAt: "v1" },
    },
  ]);
  const accessibility = await new AxeBuilder({ page })
    .include("#site-311-batch")
    .include(".site-directory-list")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("program creation needs no staff and program names can be edited", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto("/programs/new?providerId=a");
  await expect(page.locator('[name="program-staff"]')).toHaveCount(0);
  await page
    .locator('wa-input[name="program-name"] input')
    .fill("Created Test Program");
  await page.locator('#program-form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/programs\/p$/);
  expect(writes[0].body).toEqual({
    name: "Created Test Program",
    providerId: "a",
  });
  await page
    .locator('#program-details-form wa-input[name="program-name"] input')
    .fill("Renamed Test Program");
  await page.locator('#program-details-form button[type="submit"]').click();
  await expect(page.locator("h1")).toHaveText("Renamed Test Program");
  expect(writes[1].body).toEqual({
    name: "Renamed Test Program",
    expectedUpdatedAt: "v1",
  });
  await page.goto("/sites");
  await expect(page.locator(".site-directory-meta").first()).toContainText(
    "Renamed Test Program",
  );
  await expect(page.locator(".site-directory-meta").first()).not.toContainText(
    "Stale Test Program",
  );
});

test("providers are alphabetical, and the Site record does not require a manager", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/sites/new");
  await expect(page.locator('[name="provider-id"] wa-option')).toHaveText([
    "Alpha Test Provider",
    "Zebra Test Provider",
  ]);
  await page.goto("/sites/new?providerId=a&programId=p");
  await expect(page.locator("#new-site-record-form")).toBeVisible();
  await expect(page.locator('[name="site-manager-user-id"]')).toHaveCount(0);
  await expect(page.locator("#new-site-record-form")).toContainText(
    t("admin.sites.assignManagerLater"),
  );
});

test("manager creation has a separate button and returns focus after cancel", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/sites/one");
  const create = page.locator("#create-site-manager");
  await expect(create).toBeVisible();
  await expect(
    page.locator(
      '[aria-labelledby="site-managers-title"] .panel__head #create-site-manager',
    ),
  ).toBeVisible();
  await expect(page.locator("[data-manager-search]")).toHaveAttribute(
    "label",
    t("admin.siteManagers.assignExisting"),
  );
  await expect(page.locator('[value="__create_site_manager__"]')).toHaveCount(
    0,
  );
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#new-site-manager-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
});

test("compliance managers cannot edit the list delivery setting", async ({
  page,
}) => {
  await setup(page, false);
  await page.goto("/sites");
  await expect(page.locator(".site-directory")).toBeVisible();
  await expect(page.locator("[data-site-311]")).toHaveCount(0);
});

test("a partial 311 save retains conflicts until reviewed", async ({
  page,
}) => {
  const { sites } = await setup(page);
  let attempts = 0;
  await page.route("**/sites/two/deliberate-311", async (route) => {
    attempts++;
    if (attempts === 1) {
      sites[1].updatedAt = "v2";
      await route.fulfill({ status: 409, json: { error: "site_changed" } });
    } else {
      expect(route.request().postDataJSON().expectedUpdatedAt).toBe("v2");
      Object.assign(sites[1], {
        deliberate311ProductionEnabled: false,
        updatedAt: "v3",
      });
      await route.fulfill({ json: { site: sites[1] } });
    }
  });
  await page.goto("/sites");
  for (const id of ["one", "two"]) {
    await page.locator(`[data-site-311="${id}"]`).focus();
    await page.keyboard.press("Space");
  }
  await page.locator("[data-save-311]").click();
  await expect(page.locator('[data-review-311="two"]')).toBeVisible();
  await expect(page.locator("[data-save-311]")).toBeDisabled();
  expect(sites[0].deliberate311ProductionEnabled).toBe(false);
  expect(sites[1].deliberate311ProductionEnabled).toBe(true);
  await page.locator('[data-review-311="two"]').click();
  await page.locator("[data-save-311]").click();
  await expect(page.locator("[data-save-311]")).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(sites[1].deliberate311ProductionEnabled).toBe(false);
});

for (const [providerChanged, programChanged] of [
  [false, true],
  [true, false],
  [true, true],
]) {
  test(`affiliation confirmation: provider changed ${providerChanged}, program changed ${programChanged}`, async ({
    page,
  }) => {
    const { sites } = await setup(page);
    /** @type {any[]} */
    const requests = [];
    await page.route("**/sites/one/reassign", async (route) => {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (body.preview) {
        await route.fulfill({
          json: {
            preview: {
              updatedAt: "v1",
              previousProvider: "Alpha Test Provider",
              newProvider: "Alpha Test Provider",
              previousProgram: "Current Test Program",
              newProgram: "",
              retainedManagers: [],
              affectedProviderDevices: 0,
            },
          },
        });
      } else {
        await route.fulfill({
          json: {
            site: {
              ...sites[0],
              providerId: body.providerId,
              leadProgramId: body.leadProgramId,
              programName: "",
              updatedAt: "v2",
            },
          },
        });
      }
    });
    await page.goto("/sites");
    await page.locator('.site-directory-row__main[href="/sites/one"]').click();
    const select = page.locator('wa-select[name="lead-program-id"]');
    await expect(select).toHaveAttribute(
      "label",
      t("admin.relationships.leadProgram"),
    );
    if (programChanged) {
      await select.click();
      await select.locator('wa-option[value=""]').click();
    }
    if (providerChanged) {
      const provider = page.locator('wa-select[name="lead-provider-id"]');
      await provider.click();
      await provider.locator('wa-option[value="z"]').click();
    }
    await page.locator("[data-save-lead-program]").click();
    await expect(
      page.locator("#lead-program-confirmation-dialog"),
    ).toBeVisible();
    await expect(page.locator("#lead-program-confirmation-title")).toHaveText(
      t("admin.relationships.confirmSiteChange"),
    );
    const copy = page.locator("#lead-program-confirmation-copy");
    if (providerChanged) {
      await expect(copy).toBeVisible();
      await expect(copy).toHaveText(
        t("admin.relationships.providerAccessWarning"),
      );
    } else await expect(copy).toBeHidden();
    await expect(page.locator("[data-reassignment-preview]")).toHaveCount(0);
    await page
      .locator('#lead-program-confirmation-dialog button[value="confirm"]')
      .click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual({
      providerId: providerChanged ? "z" : "a",
      leadProgramId: programChanged ? "" : "p",
      expectedUpdatedAt: "v1",
    });
    await expect(
      page.locator('wa-select[name="lead-program-id"]'),
    ).toHaveJSProperty("value", programChanged ? "" : "p");
    await page.locator('a[data-route][href="/sites"]').first().click();
    const row = page.locator('.site-directory-row__main[href="/sites/one"]');
    await expect(row).toContainText(
      providerChanged ? "Zebra Test Provider" : "Alpha Test Provider",
    );
    if (programChanged)
      await expect(row).not.toContainText("Current Test Program");
    else await expect(row).toContainText("Current Test Program");
  });
}

test("existing manager search debounces, matches email, and requires a fresh selection", async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.route("**/admin/v1/people", (route) =>
    route.fulfill({
      json: {
        people: [
          {
            personId: "sam",
            firstName: "Sam",
            lastName: "Example",
            email: "sam@example.org",
            status: "active",
          },
          {
            personId: "jo",
            firstName: "Jo",
            lastName: "Example",
            email: "jo@example.org",
            status: "active",
          },
        ],
      },
    }),
  );
  await page.goto("/sites/one");
  const search = page.locator("[data-manager-search] input");
  const results = page.locator("[data-manager-search-results]");
  const actions = page.locator("[data-manager-membership-actions]");
  await search.fill("sam@");
  await expect(results).toBeHidden();
  await expect(results).toBeVisible();
  await expect(results.locator("li:visible")).toHaveCount(1);
  await expect(results).toContainText("sam@example.org");
  expect(
    (
      await new AxeBuilder({ page })
        .include("#manager-membership-form")
        .analyze()
    ).violations,
  ).toEqual([]);
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(actions).toBeVisible();
  await search.fill("no such person");
  await expect(actions).toBeHidden();
  await expect(results).toBeHidden();
  await expect(page.locator("[data-manager-search-status]")).toHaveText(
    t("admin.siteManagers.searchNone"),
  );
  await search.fill("jo example");
  await expect(results).toBeVisible();
  await search.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      () =>
        writes.filter((w) => w.path.endsWith("/manager-memberships")).length,
    )
    .toBe(1);
  expect(
    writes.find((w) => w.path.endsWith("/manager-memberships"))?.body,
  ).toMatchObject({ personId: "jo" });
});
