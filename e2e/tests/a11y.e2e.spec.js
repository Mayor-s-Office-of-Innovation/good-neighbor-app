// @ts-check
import { a11yMatrix, matrix, test } from "ramp-check/test";
import { expect, boundPage } from "../helpers/harness.js";
import { startCheck, openHistoryWithTrays } from "../helpers/app.js";

/*
  Automated accessibility scans via ramp-check inside the existing e2e suite.

  One test per state, generated across a theme/motion matrix by a11yMatrix /
  matrix (each cell owns its own correctly scoped test.use(), so the
  last-value-wins pitfall of repeated file-level test.use() calls cannot
  happen).

  ramp-check's fixtures replace the hand-rolled settle()/scan()/assertClean()
  this file used to carry: a11y.check() waits for finite animations to settle
  (shadow-root aware), runs axe (WCAG A+AA findings blocking, AAA as
  warnings per the policy, best-practice rules blocking), audits motion under
  reduced motion (including view transitions — app-root.js uses
  startViewTransition for route swaps), audits reflow at 320px, runs a full
  keyboard audit (Tab traversal: reachability, visible focus, focus not
  obscured, no trap) and a text-spacing check (warns by default), and records
  warnings as annotations with the full result attached as JSON.

  States (same five as before):
    - code entry (unbound): the app's public front door, reached without a
      site binding. Plain page; no bindSite.
    - bound home (/today) + capture view + site admin + home history trays:
      via helpers/harness.js's shared boundPage fixture, which binds through
      the real code-entry flow.

  Policy: wcag22-aa — WCAG 2.2 A and AA findings block; AAA findings warn.
  The previous spec ran raw axe at maximum sensitivity, and the first AAA run
  confirmed what that implies: the 7:1 enhanced-contrast rule (1.4.6) fires
  across nearly every surface, which is a design-token lift, not an e2e gate.
  wcag22-aa still blocks more than the DOJ ADA Title II floor (WCAG 2.1 AA,
  compliance April 2026 for large entities); AAA findings stay visible as
  warnings.

  Exceptions: e2e/a11y-allowlist.json (formerly KNOWN_VIOLATION_PREFIXES in
  this file) — landmark-unique on .analysis-tray regions (the old filter's
  prefix covered both new and history trays), and Web Awesome's OTP caret
  blink looping under reduced motion inside its shadow root, each with a
  reason and an expiry; an expired entry fails the run by name. ramp-check
  also annotates allowlist entries that stopped matching anything, so a fixed
  product means the entry flags itself for removal.
*/

/** @type {import("ramp-check/test").RampCheckConfig} */
const A11Y_CONFIG = {
  policy: "wcag-aaa",
  allowlist: "./a11y-allowlist.json",
};

/* ------------------------------------------------------------------ */
/* Code entry (unbound) — plain page, real front door.                */
/* ------------------------------------------------------------------ */

a11yMatrix(
  { colorScheme: ["light", "dark"], reducedMotion: ["reduce"] },
  () => {
    test.use({ a11yConfig: A11Y_CONFIG });
    test("a11y: code entry", async ({ page, a11y }) => {
      await page.goto("/");
      await expect(page.locator("wa-otp-input#code-input")).toBeVisible();
      await a11y.check("code entry");
    });
  },
);

/* ------------------------------------------------------------------ */
/* Bound app — real bindSite flow via the shared harness fixture      */
/* (fresh context + real code-entry binding per test), composed over  */
/* ramp-check's test so both `a11y` and the bound `page` exist.       */
/* ------------------------------------------------------------------ */

const boundA11y = test.extend({ page: boundPage });

/**
 * The composed fixtures per test: harness's (now ramp-check's) bound `page`
 * plus ramp-check's `a11y`.
 * @typedef {{ page: import("@playwright/test").Page, a11y: import("ramp-check/test").A11y }} BoundA11yFixtures
 */

matrix(
  { colorScheme: ["light", "dark"], reducedMotion: ["reduce"] },
  () => {
    boundA11y.use({ a11yConfig: A11Y_CONFIG });

    boundA11y(
      "a11y: bound home",
      async (/** @type {BoundA11yFixtures} */ { page, a11y }) => {
        await expect(page.locator("#start-check")).toBeVisible();
        await a11y.check("bound home");
      },
    );

    boundA11y(
      "a11y: capture view",
      async (/** @type {BoundA11yFixtures} */ { page, a11y }) => {
        await startCheck(page);
        await expect(page.locator("#add-photo")).toBeVisible();
        await a11y.check("capture view");
      },
    );

    boundA11y(
      "a11y: site admin",
      async (/** @type {BoundA11yFixtures} */ { page, a11y }) => {
        await page.locator("#home-settings").click();
        await page.getByRole("menuitem", { name: "Site admin" }).click();
        await expect(page).toHaveURL(/\/site-admin$/);
        await expect(
          page.getByRole("heading", { name: "Site information" }),
        ).toBeVisible();
        await a11y.check("site admin");
      },
    );

    // Home's History tab with real historical check trays. The only scanned
    // state that renders .analysis-tray--history — required to catch
    // theme-dependent styling on tray surfaces (a dark-mode title/background
    // contrast bug shipped because every other scanned state has no trays),
    // and the state the landmark-unique allowlist entry scopes to.
    boundA11y(
      "a11y: home history trays",
      async (/** @type {BoundA11yFixtures} */ { page, a11y }) => {
        await openHistoryWithTrays(page);
        await a11y.check("home history trays");
      },
    );
  },
  { test: boundA11y },
);
