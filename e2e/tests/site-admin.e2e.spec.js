// @ts-check
import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";
import { bindSite } from "../helpers/app.js";

test.describe("site admin access", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page);
  });

  test("settings entry points and routed admin views work end to end", async ({
    page,
  }) => {
    // Feedback now lives only in the settings menu; the old floating trigger
    // must not return.
    await expect(page.locator("#feedback-open")).toHaveCount(0);

    await page.locator("#home-settings").click();
    const menu = page.getByRole("menu", { name: t("today.settings.aria") });
    await expect(menu.getByRole("menuitem")).toHaveText([
      t("access.title"),
      t("today.settings.siteAdmin"),
      t("today.settings.reports"),
      t("today.settings.feedback"),
      t("today.settings.language"),
      t("today.settings.attributions"),
      t("today.settings.logout"),
    ]);

    await menu
      .getByRole("menuitem", { name: t("today.settings.attributions") })
      .click();
    const attributions = page.locator("#attributions-dialog");
    await expect(attributions).toBeVisible();
    await expect(
      attributions.getByRole("link", {
        name: t("today.attributions.aws"),
      }),
    ).toBeVisible();
    await expect(
      attributions.getByRole("link", { name: t("today.attributions.census") }),
    ).toBeVisible();
    await attributions.getByRole("button", { name: t("common.close") }).click();

    await page.locator("#home-settings").click();
    await page
      .getByRole("menuitem", { name: t("today.settings.feedback") })
      .click();
    const feedback = page.locator("#feedback-dialog");
    await expect(feedback).toBeVisible();
    await feedback.getByRole("button", { name: t("common.cancel") }).click();

    // Closing these settings sheets removes the menu without a home render.
    // Reopening must not mistake cached markup for a menu still in the DOM.
    await page.locator("#home-settings").click();
    await expect(menu).toBeVisible();
    await menu
      .getByRole("menuitem", { name: t("today.settings.language") })
      .click();
    const language = page.locator("#language-dialog");
    await expect(language).toBeVisible();
    await language.getByRole("button", { name: t("common.close") }).click();

    await page.locator("#home-settings").click();
    await page
      .getByRole("menuitem", { name: t("today.settings.siteAdmin") })
      .click();
    await expect(page).toHaveURL(/\/site-admin$/);
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.siteDetails.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.contact.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.oversight.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: t("siteAdmin.compliance.title"),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.perimeter.title") }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: t("siteAdmin.letters.title"),
        exact: true,
      }),
    ).toBeVisible();

    const contactSection = page.locator(".site-admin-section", {
      has: page.getByRole("heading", { name: t("siteAdmin.contact.title") }),
    });
    await contactSection
      .getByRole("button", { name: t("common.edit") })
      .click();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.edit.contactTitle") }),
    ).toBeVisible();
    await expect(page.locator("#site-admin-save")).toBeDisabled();

    // A routed edit view survives a reload and restores its server-backed
    // state instead of dropping back to the home or summary view.
    await page.reload();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(page.locator("#site-admin-save")).toBeDisabled();

    const lastName = page.locator("#admin-last-name input");
    await lastName.fill("Unsaved change");
    await expect(page.locator("#site-admin-save")).toBeEnabled();
    await page.evaluate(() => window.history.back());

    const discard = page.locator("#site-admin-discard-dialog");
    await expect(discard).toBeVisible();
    await discard
      .getByRole("button", { name: t("common.keepEditing") })
      .click();
    await expect(page).toHaveURL(/\/site-admin\/edit\/contact$/);
    await expect(lastName).toHaveValue("Unsaved change");

    await page.locator("[data-admin-back]").click();
    await discard
      .getByRole("button", { name: t("common.discardChanges") })
      .click();
    await expect(page).toHaveURL(/\/site-admin$/);

    await page.locator("[data-admin-back]").click();
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
  });
});

test.describe("general site access", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page, {
      siteCode: "GUBMIS",
      siteName: "Mission District",
    });
  });

  test("does not expose or allow the site admin view", async ({ page }) => {
    await page.locator("#home-settings").click();
    await expect(page.locator("#settings-site-admin")).toHaveCount(0);

    await page.goto("/site-admin");
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
    await expect(
      page.getByRole("heading", { name: t("siteAdmin.title") }),
    ).toHaveCount(0);
  });
});

test("access links stack, collapse, disappear after enrollment, and stay hidden after reopening", async ({
  page,
}) => {
  await bindSite(page);
  /** @type {Array<{grantId: string, label: string, status: string, expiresAt: string}>} */
  const grants = [];
  await page.route("**/app/v1/manager/staff-grants/current", (route) =>
    route.fulfill({ json: { grants } }),
  );
  await page.route("**/app/v1/manager/staff-grants", async (route) => {
    const label = route.request().postDataJSON().label;
    const grant = {
      grantId: `grant-${grants.length}`,
      label,
      status: "pending",
      expiresAt: new Date(Date.now() + 479 * 60000).toISOString(),
    };
    grants.push(grant);
    await route.fulfill({
      status: 201,
      json: {
        grant,
        enrollmentUrl: `https://example.test/#enrollment_grant=${grant.grantId}&enrollment_token=secret`,
      },
    });
  });
  await page.locator("#home-settings").click();
  await page.locator("#settings-access").click();
  await expect(page).toHaveURL(/\/manage-access$/);
  const name = page.locator("#staff-device-label input");
  for (const [index, label] of ["First phone", "Second phone"].entries()) {
    await name.fill(label);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/manager/staff-grants"),
    );
    await page.locator('#staff-grant-form button[type="submit"]').click();
    expect((await created).status()).toBe(201);
    await expect(page.locator("[data-grant-id]")).toHaveCount(index + 1);
    await expect(
      page.locator(`[data-grant-id="grant-${index}"]`),
    ).toBeVisible();
  }
  const cards = page.locator("[data-grant-id]");
  await expect(cards.first()).toHaveAttribute("open", "");
  await expect(cards.last()).not.toHaveAttribute("open", "");
  await expect(cards.first()).toContainText(
    t("access.duration.hours.other", { count: 7 }),
  );
  await cards.last().locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(cards.last()).toHaveAttribute("open", "");
  grants[0].status = "redeemed";
  await expect(page.locator('[data-grant-id="grant-0"]')).toHaveCount(0, {
    timeout: 12000,
  });
  await expect(page.locator('[data-grant-id="grant-1"]')).toHaveCount(1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: t("access.title"), exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-grant-id="grant-1"]')).toBeVisible();
  await expect(page.locator("wa-qr-code")).toHaveCount(0);
  await expect(page.locator("[data-share-grant]")).toHaveCount(0);
  await page.route("**/app/v1/manager/staff-grants/grant-1", (route) => {
    grants[1].status = "cancelled";
    return route.fulfill({ json: {} });
  });
  await page
    .locator('[data-grant-id="grant-1"] [data-cancel-staff-grant]')
    .click();
  await expect(page.locator("[data-grant-id]")).toHaveCount(0);
  await expect(
    page.locator('#staff-grant-form button[type="submit"]'),
  ).toBeEnabled();
});
