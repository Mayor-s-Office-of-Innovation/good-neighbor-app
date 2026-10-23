// @ts-check
/*
  ramp-check against the frontend-only dev server (`npm run dev:remote`):
  the designer's accessibility pass. No backend, Java, or Playwright spec
  needed. Run it with `npm run a11y:local -w e2e`, which binds the site once
  (saved to .a11y-local/state.json, reused by every matrix cell) and then
  runs this config. Screenshots with every finding boxed and numbered land in
  ramp-check-report/screenshots/; ramp-check-report/ramp-check.md explains
  each number.

  The same states as tests/a11y.e2e.spec.js, except two that need writes:
  code entry (every context here starts bound) and the photo lightbox
  (uploading a photo is a real check in dev). The reports screens use the
  spec's route stubs so the day page and 311 sheet always have content.
*/
import { REPORT_DAY, stubReports } from "./helpers/reports.js";

export default {
  baseURL: process.env.A11Y_LOCAL_BASE_URL || "http://127.0.0.1:5173",
  storageState: "./.a11y-local/state.json",
  // Installed once per cell, before the pages, so reports render from the
  // fixed week regardless of what the dev site holds today.
  setup: stubReports,
  matrix: {
    colorScheme: ["light", "dark"],
    reducedMotion: ["reduce"],
    viewport: ["mobile", "desktop"],
  },
  // Same policy as the e2e suite: 2.2 A/AA fail (red); AAA, such as the 7:1
  // enhanced-contrast rule, warn (blue). Both are boxed in the screenshots.
  policy: "wcag22-aa",
  allowlist: "./a11y-allowlist.json",
  consistency: false,
  // Per-action timeout. Dev data and a cold Vite server are slower than the
  // e2e harness; ramp-check's default is 30 s.
  timeout: 60_000,
  out: "./ramp-check-report",
  pages: [
    { path: "/today", name: "bound home", waitFor: "#start-check" },
    {
      path: "/today",
      name: "capture view",
      waitFor: "#start-check",
      // Starting a check is local state only (IndexedDB) until a photo is added.
      setup: async (page) => {
        await page.locator("#start-check").click();
        await page.locator("#add-photo").waitFor();
      },
    },
    {
      path: "/today",
      name: "home history",
      waitFor: "#start-check",
      setup: async (page) => {
        await page.locator('.home-tabs [data-home-filter="history"]').click();
        // Whatever history the dev site has; an empty History is still a state.
        await page
          .locator(".analysis-tray--history")
          .first()
          .waitFor({ timeout: 10_000 })
          .catch(() => {});
      },
    },
    {
      path: "/site-admin",
      name: "site admin",
      waitFor: '[data-edit-section="site"]',
    },
    { path: "/reports", name: "reports", waitFor: ".reports__record" },
    {
      path: "/reports?tab=issues",
      name: "report issues",
      waitFor: '.reports__record[data-task-id="t1"]',
    },
    {
      path: `/reports/checks/${REPORT_DAY}`,
      name: "report day",
      waitFor: ".reports-timeline__item--done",
    },
    {
      path: `/reports/checks/${REPORT_DAY}`,
      name: "report day 311 sheet",
      waitFor: ".reports-timeline__item--done",
      setup: async (page) => {
        await page
          .locator('.analysis-card[data-task-id="t1"] [data-action="view311"]')
          .click();
        await page
          .locator("#ticket-detail-dialog[open] #ticket-detail-title")
          .waitFor();
      },
    },
    {
      path: "/reports/issues/Litter?period=week&start=2026-09-27",
      name: "report type",
      waitFor: '.analysis-card[data-task-id="t1"]',
    },
  ],
};
