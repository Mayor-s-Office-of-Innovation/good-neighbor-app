// @ts-check
import { test, expect } from "@playwright/test";
import { t } from "../helpers/i18n.js";
import { bindSite } from "../helpers/app.js";
import {
  CHECKS_REPORT,
  REPORT_DAY,
  openReports,
  stubReports,
} from "../helpers/reports.js";

test.describe("site manager reports", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page);
    await stubReports(page);
  });

  test("the Checks report, its period controls, and a day's detail", async ({
    page,
  }) => {
    await openReports(page);
    await expect(page).toHaveURL(
      /\/reports\?tab=checks&period=week&start=2026-09-27/,
    );
    await expect(
      page.getByRole("heading", { name: t("reports.title") }),
    ).toBeVisible();

    const { totals } = CHECKS_REPORT;
    await expect(
      page.getByRole("heading", {
        name: t("reports.checks.headline", {
          completed: totals.completed,
          possible: totals.possible,
        }),
      }),
    ).toBeVisible();

    // The week strip carries every day's count and status in text.
    const calendar = page.getByRole("list", {
      name: t("reports.checks.calendarAria"),
    });
    await expect(calendar).toBeVisible();
    await expect(
      calendar.getByLabel(
        t("reports.checks.dayCell", {
          date: "Sep 28",
          completed: 1,
          required: 3,
          status: t("reports.status.partial"),
        }),
      ),
    ).toBeVisible();

    // Records: owed days only, newest first, with the status word.
    const records = page.locator(".reports__record");
    await expect(records).toHaveCount(4);
    await expect(records.first()).toContainText(t("reports.status.pending"));
    await expect(records.first()).toContainText(
      t("reports.day.today", { date: "Sep 30" }),
    );

    // The period type select is labelled and keyboard operable; choosing
    // Quarter requests that period (the stub answers with the same week, so
    // the screen settles back on it) and keeps focus on the control.
    const kind = page.locator("#reports-kind");
    const kindControl = kind.getByRole("combobox", {
      name: t("reports.filters.kind"),
    });
    // The text label is visually hidden (the value is the label); the
    // control still announces it.
    await expect(kindControl).toHaveAccessibleName(t("reports.filters.kind"));
    await kindControl.focus();
    await expect(kindControl).toBeFocused();
    await kindControl.press("ArrowDown");
    await kindControl.press("End");
    const quarterRequest = page.waitForRequest((request) =>
      request.url().includes("/reports/checks?period=quarter"),
    );
    await kindControl.press("Enter");
    await quarterRequest;
    await expect(page.locator(".reports__records")).toBeVisible();
    await expect(
      page.locator("#reports-kind").getByRole("combobox", {
        name: t("reports.filters.kind"),
      }),
    ).toBeFocused();

    // A record's title links to the day detail.
    const dayTitle = t("reports.day.yesterday", { date: "Sep 29" });
    await page
      .getByRole("link", { name: t("reports.day.open", { title: dayTitle }) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/reports/checks/${REPORT_DAY}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      dayTitle,
    );
    await expect(page.locator(".reports-timeline__item--done")).toHaveCount(2);
    await expect(page.locator(".reports-timeline__item--missed")).toHaveCount(
      1,
    );
    // Each issue is the home hub's card, read-only but for its updates row,
    // with the street and thumbnail hydrated from the check.
    const card311 = page.locator('.analysis-card[data-task-id="t1"]');
    await expect(card311).toContainText("GUB-STJ-041");
    await expect(card311).toContainText("15th St");
    await expect(card311.locator("img")).toHaveCount(1);
    await expect(card311.locator("[data-analysis-action]")).toHaveCount(0);

    // A 311 request opens the request sheet; closing it returns focus.
    const view311 = card311.locator('[data-action="view311"]');
    await view311.click();
    const sheet = page.locator("#ticket-detail-dialog[open]");
    await expect(sheet.locator("#ticket-detail-title")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(view311).toBeFocused();

    // Any other issue opens the updates timeline.
    const cardPlain = page.locator('.analysis-card[data-task-id="t2"]');
    await cardPlain.locator('[data-action="update"]').click();
    const updates = page.locator("dialog.task-update[open]");
    await expect(updates).toBeVisible();
    await updates.locator("[data-close]").click();
    await expect(updates).toHaveCount(0);
    await expect(cardPlain.locator('[data-action="update"]')).toBeFocused();

    await page.getByRole("link", { name: t("reports.day.back") }).click();
    await expect(page).toHaveURL(/\/reports(\?|$)/);
    await expect(page.locator(".reports__records")).toBeVisible();

    // The gear menu is here too, and the back link returns home.
    await page.locator("#home-settings").click();
    const menu = page.getByRole("menu", { name: t("today.settings.aria") });
    await expect(menu.getByRole("menuitem")).toHaveText([
      t("today.settings.feedback"),
      t("today.settings.siteAdmin"),
      t("today.settings.reports"),
      t("today.settings.language"),
      t("today.settings.attributions"),
      t("today.settings.logout"),
    ]);
    await menu
      .getByRole("menuitem", { name: t("today.settings.attributions") })
      .click();
    const attributions = page.locator("#attributions-dialog");
    await expect(attributions).toBeVisible();
    await attributions.getByRole("button", { name: t("common.close") }).click();
    await expect(attributions).toBeHidden();
    await page.getByRole("link", { name: t("reports.backHome") }).click();
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
    await expect(page.locator("#start-check")).toBeVisible();
  });

  test("the Issues tab combines what was found with what was done", async ({
    page,
  }) => {
    await openReports(page);
    const tab = page.getByRole("button", { name: t("reports.tab.issues") });
    await tab.click();
    await expect(page).toHaveURL(/tab=issues/);
    await expect(
      page.getByRole("heading", {
        name: t("reports.issues.headline", { count: 2 }),
      }),
    ).toBeVisible();
    const row = page.locator('.reports__record[data-task-id="t1"]');
    await expect(row).toContainText("GUB-STJ-041");
    await expect(row).toContainText(
      t("reports.issues.response.label", {
        response: t("reports.issues.response.sr311"),
      }),
    );
    await expect(
      page.locator('.reports__record[data-task-id="t2"]'),
    ).toContainText(
      t("reports.issues.response.label", {
        response: t("reports.issues.response.onSite"),
      }),
    );
    await expect(
      page.getByRole("button", { name: t("reports.tab.issues") }),
    ).toBeFocused();

    // A type row drills into that type's screen: the period travels with
    // it, the cards are the home hub's, and the 311 sheet opens from one.
    await page
      .getByRole("link", {
        name: t("reports.issues.types.open", { type: "Litter" }),
      })
      .click();
    await expect(page).toHaveURL(
      /\/reports\/issues\/Litter\?period=week&start=2026-09-27$/,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Litter");
    await expect(page.locator(".reports-chart")).toBeVisible();
    const typeCard = page.locator('.analysis-card[data-task-id="t1"]');
    await expect(typeCard).toContainText("15th St");
    await expect(page.locator('.analysis-card[data-task-id="t2"]')).toHaveCount(
      0,
    );
    await typeCard.locator('[data-action="view311"]').click();
    await expect(
      page.locator("#ticket-detail-dialog[open] #ticket-detail-title"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(typeCard.locator('[data-action="view311"]')).toBeFocused();
    await page.getByRole("link", { name: t("reports.type.back") }).click();
    await expect(page).toHaveURL(/tab=issues&period=week&start=2026-09-27/);
    await expect(
      page.locator('.reports__record[data-task-id="t1"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: t("reports.tab.issues") }).focus();
    // Arrow keys move between tabs.
    await page.keyboard.press("ArrowLeft");
    await expect(page).toHaveURL(/tab=checks/);
    await expect(page.locator(".reports__records")).toBeVisible();
  });

  test("a direct deep link to a day works", async ({ page }) => {
    await page.goto(`/reports/checks/${REPORT_DAY}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      t("reports.day.yesterday", { date: "Sep 29" }),
    );
  });
});

test.describe("general site access", () => {
  test.beforeEach(async ({ page }) => {
    await bindSite(page, {
      siteCode: "GUBMIS",
      siteName: "Mission District",
    });
  });

  test("does not expose or allow the reports", async ({ page }) => {
    await page.locator("#home-settings").click();
    await expect(page.locator("#settings-reports")).toHaveCount(0);

    await page.goto("/reports");
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
    await expect(
      page.getByRole("heading", { name: t("reports.title") }),
    ).toHaveCount(0);
  });
});
