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
        name: t("reports.checks.recorded", { count: totals.recorded }),
      }),
    ).toBeVisible();

    // The week strip carries every day's count and status in text.
    const calendar = page.getByRole("list", {
      name: t("reports.checks.calendarAria"),
    });
    await expect(calendar).toBeVisible();
    await expect(
      calendar.getByLabel(
        `Sep 28: ${t("reports.checks.recorded", { count: 1 })}`,
      ),
    ).toBeVisible();

    // Only days with recorded checks appear, newest first.
    const records = page.locator(".reports__record");
    await expect(records).toHaveCount(4);
    await expect(records.first().locator(".reports-pill")).toHaveCount(0);
    await expect(records.first()).toContainText("Sep 30");

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
    const dayTitle = "Sep 29";
    await page.locator(`.reports__record[data-day="${REPORT_DAY}"] a`).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/reports/checks/${REPORT_DAY}\\?period=week&start=2026-09-27$`,
      ),
    );
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      dayTitle,
    );
    await expect(page.locator(".reports-timeline__item--done")).toHaveCount(2);
    await expect(page.locator(".reports-timeline__item--missed")).toHaveCount(
      0,
    );
    // Each issue is the home hub's card, read-only but for its updates row,
    // with the street and thumbnail hydrated from the check.
    const card311 = page.locator('.analysis-card[data-task-id="t1"]');
    await expect(card311).toContainText("GUB-STJ-041");
    await expect(card311).toContainText("15th St");
    await expect(card311.locator("img")).toHaveCount(1);
    await expect(card311.locator("[data-analysis-action]")).toHaveCount(0);

    // Filed tickets use the same read-only timeline as other report issues.
    const viewTimeline = card311.getByRole("button", {
      name: t("reports.viewTimeline"),
    });
    await viewTimeline.click();
    const sheet = page.locator("dialog.task-update[open]");
    await expect(sheet.locator(".task-update__timeline")).toBeVisible();
    await expect(
      sheet.locator("[data-add-note], [data-add-photo], [data-resolve]"),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(viewTimeline).toBeFocused();

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

    // Closing Reports returns home even after drilling into a day and back.
    await expect(page.locator("#home-settings")).toHaveCount(0);
    await page.locator("#reports-home").click();
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
    const row = page.locator('.analysis-card[data-task-id="t1"]');
    await expect(row).toContainText("GUB-STJ-041");
    await expect(
      row.getByRole("button", { name: t("reports.viewTimeline") }),
    ).toBeVisible();
    await expect(
      page.locator('.analysis-card[data-task-id="t2"]'),
    ).toContainText("GUB-STJ-042");
    await expect(
      page.getByRole("button", { name: t("reports.tab.issues") }),
    ).toBeFocused();

    // A type row drills into that type's screen: the period travels with
    // it, the cards are the home hub's, and the read-only timeline opens from one.
    await page
      .locator('.reports-types__link[href^="/reports/issues/Litter?"]')
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
    await typeCard
      .getByRole("button", { name: t("reports.viewTimeline") })
      .click();
    await expect(
      page.locator("dialog.task-update[open] .task-update__timeline"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(typeCard.locator('[data-action="update"]')).toBeFocused();
    await page.getByRole("link", { name: t("reports.type.back") }).click();
    await expect(page).toHaveURL(/tab=issues&period=week&start=2026-09-27/);
    // The URL changes before the view-transition swap. Both the outgoing
    // type screen and incoming report contain t1 and the Issues tab.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      t("reports.title"),
    );
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-route-transition",
      /.+/,
    );
    await expect(
      page.locator('.analysis-card[data-task-id="t1"]'),
    ).toBeVisible();
    // Arrow keys move between tabs.
    await page
      .getByRole("button", { name: t("reports.tab.issues") })
      .press("ArrowLeft");
    await expect(page).toHaveURL(/tab=checks/);
    await expect(page.locator(".reports__records")).toBeVisible();
  });

  test("unknown issue types show not-found while known empty types keep their report", async ({
    page,
  }) => {
    await page.goto(
      "/reports/issues/not-a-real-type?period=week&start=2026-09-27",
    );
    await expect(page.getByRole("status")).toHaveText(
      t("reports.type.notFound"),
    );
    await page.goto("/reports/issues/Needles?period=week&start=2026-09-27");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Needles");
    await expect(page.locator(".reports__records-sub")).toHaveText(
      t("reports.issues.byType.count", { count: 0 }),
    );
    await expect(page.locator("#reports-kind")).toBeVisible();
  });

  test("a direct deep link to a day works", async ({ page }) => {
    await page.goto(`/reports/checks/${REPORT_DAY}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Sep 29",
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
