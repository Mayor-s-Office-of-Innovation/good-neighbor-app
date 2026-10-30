import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

/** @param {import('@playwright/test').Page} page @param {boolean} [supervisor] */
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
  const site = {
    sk: "#META",
    siteId: "synthetic-site",
    name: "Synthetic Site",
    status: "active",
    updatedAt: "version-1",
    providerId: "provider",
    address: "1 Example Street",
  };
  /** @type {Array<Record<string, any>>} */
  const changes = [];
  const failure = { enabled: false };
  await page.route("**/admin/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path.endsWith("/session"))
      json = {
        role: supervisor ? "compliance-supervisor" : "compliance-manager",
        capabilities: {
          createEntities: supervisor,
          manageAdminUsers: supervisor,
        },
      };
    else if (path.endsWith("/deliberate-311")) {
      if (failure.enabled)
        return route.fulfill({ status: 409, json: { error: "site_changed" } });
      const body = route.request().postDataJSON();
      changes.push(body);
      Object.assign(site, {
        deliberate311ProductionEnabled: body.deliberate311ProductionEnabled,
        updatedAt: "version-2",
      });
      json = { site };
    } else if (path.endsWith("/sites/synthetic-site"))
      json = { items: [site], permissions: { canEdit: true } };
    else if (path.endsWith("/providers"))
      json = {
        providers: [{ providerId: "provider", name: "Synthetic Provider" }],
      };
    else if (path.endsWith("/sites")) json = { sites: [site] };
    await route.fulfill({ json });
  });
  await page.goto("/sites/synthetic-site");
  await expect(page.locator("#site-details-form")).toBeVisible();
  return { changes, failure };
}

test("supervisor can disable deliberate filing with keyboard, preserve defaults and save accessibly", async ({
  page,
}) => {
  const { changes } = await setup(page);
  await expect(page.locator("#site-deliberate-311-form")).toHaveCount(0);
  const settings = page.getByRole("link", {
    name: t("admin.sites.appSettings"),
    exact: true,
  });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/section=settings/);
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#site-details-form")).toHaveCount(0);
  const form = page.locator("#site-deliberate-311-form");
  await expect(
    page.getByRole("heading", {
      name: t("admin.sites.deliberate311.title"),
      exact: true,
    }),
  ).toHaveText(t("admin.sites.deliberate311.title"));
  await expect(form.locator("p")).toHaveText(
    t("admin.sites.deliberate311.hint"),
  );
  const select = form.locator("wa-select");
  await expect(select).toHaveAttribute(
    "label",
    t("admin.sites.deliberate311.label"),
  );
  const save = form.getByRole("button", {
    name: t("common.save"),
    exact: true,
  });
  await expect(select).toHaveJSProperty("value", "true");
  await expect(save).toBeDisabled();
  await select.getByRole("combobox").focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("option", {
      name: t("admin.sites.deliberate311.simulated"),
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(select).toHaveJSProperty("value", "false");
  await expect(save).toBeEnabled();
  await expect(
    page.getByRole("option", {
      name: t("admin.sites.deliberate311.simulated"),
      exact: true,
    }),
  ).not.toBeVisible();
  await select.getByRole("combobox").focus();
  await page.keyboard.press("Tab");
  await expect(save).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => changes.length).toBe(1);
  expect(changes[0]).toEqual({
    deliberate311ProductionEnabled: false,
    expectedUpdatedAt: "version-1",
  });
  await expect(save).toBeDisabled();
  await expect(form).toHaveAttribute("data-is-dirty", "false");
  const a11y = await new AxeBuilder({ page })
    .include("#site-deliberate-311-form")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
});

test("Managers cannot see the supervisor-only delivery setting", async ({
  page,
}) => {
  await setup(page, false);
  await expect(page.locator("#site-deliberate-311-form")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: t("admin.sites.appSettings"), exact: true }),
  ).toHaveCount(0);
  await page.goto("/sites/synthetic-site?section=settings");
  await expect(page.locator("#site-details-form")).toBeVisible();
  await expect(page.locator("#site-deliberate-311-form")).toHaveCount(0);
});

test("settings drafts survive navigation cancellation and failed saves", async ({
  page,
}) => {
  const { failure } = await setup(page);
  await page
    .getByRole("link", { name: t("admin.sites.appSettings"), exact: true })
    .click();
  const form = page.locator("#site-deliberate-311-form");
  const select = form.locator("wa-select");
  await select.getByRole("combobox").click();
  await page
    .getByRole("option", {
      name: t("admin.sites.deliberate311.simulated"),
      exact: true,
    })
    .click();
  await expect(select).toHaveJSProperty("value", "false");
  await page.locator('.entity-tabs a[href$="section=details"]').click();
  await expect(page.locator("#site-unsaved-dialog")).toBeVisible();
  await page
    .getByRole("button", { name: t("common.keepEditing"), exact: true })
    .click();
  await expect(page).toHaveURL(/section=settings/);
  const save = form.getByRole("button", {
    name: t("common.save"),
    exact: true,
  });
  failure.enabled = true;
  await save.click();
  await expect(form.locator("[data-form-save-error]")).toBeVisible();
  await expect(select).toHaveJSProperty("value", "false");
  await expect(select).not.toHaveAttribute("disabled", "");
  await expect(save).toBeEnabled();
  await expect(form).toHaveAttribute("data-is-dirty", "true");
  failure.enabled = false;
  await save.click();
  await expect(save).toBeDisabled();
  await expect(form).toHaveAttribute("data-is-dirty", "false");
  await page.locator('.entity-tabs a[href$="section=details"]').click();
  await expect(page.locator("#site-details-form")).toBeVisible();
  await expect(page.locator("#site-deliberate-311-form")).toHaveCount(0);
});
