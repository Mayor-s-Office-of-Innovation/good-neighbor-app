// @ts-check
import { AxeBuilder } from "@axe-core/playwright";
import { test, expect } from "@playwright/test";
import { test as harnessTest } from "../helpers/harness.js";
import { startCheck } from "../helpers/app.js";

/*
  Automated accessibility scans (axe-core) inside the existing e2e suite.

  One test per state, each state scanned in BOTH themes: dark mode is driven
  through the app's real follow-OS path via colorScheme emulation (the theme
  init in index.html reads matchMedia synchronously before first paint), so
  the option must be set in test.use() before the page loads. Each theme's
  test.use() lives inside its own describe block — at file scope, repeated
  test.use() calls in a loop all append to the same suite and the last value
  wins for every test (all "light" tests would silently scan a dark page).

  States:
    - code entry (unbound): the app's public front door, reached without a
      site binding. Plain page; no bindSite.
    - bound home (/today) + capture view: via helpers/harness.js, which binds
      through the real code-entry flow.

  Tags: maximum sensitivity — every axe-core tag set enabled (WCAG 2.0/2.1
  A+AA, 2.2 A+AA, axe's best-practice rules, and ACT rules), so any taggable
  rule can fire.

  Bar: maximum sensitivity — ALL violations fail, regardless of impact
  (critical → minor). Known false positives get filtered by rule id +
  component tag (axe targets inside shadow roots are nested selectors) with
  an explanatory comment and a revisit-by date per entry.

  Timing: scans must run after finite animations settle — axe samples
  computed styles, so a mid-fade element measures a blended (washed-out)
  color and reports bogus contrast violations (this actually happened on the
  capture view's 260ms home-capture-in fade).
*/

const TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "wcag22a",
  "best-practice",
  "act",
];

const THEMES = /** @type {const} */ (["light", "dark"]);

/**
 * Wait for finite animations/transitions (view fades, entrances) to finish
 * before scanning. Infinite animations (spinners) are excluded so this can't
 * hang.
 * @param {import("@playwright/test").Page} page
 */
async function settle(page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => ["running", "finished"].includes(a.playState))
        .filter((a) => {
          const t = /** @type {any} */ (a.effect)?.getComputedTiming?.();
          return t && t.iterations !== Infinity;
        })
        .map((a) => a.finished.catch(() => {})),
    ),
  );
}

/**
 * Run axe and summarize violations to short "rule: target" strings so failure
 * output names the node and rule without dumping full violation objects.
 * @param {import("@playwright/test").Page} page
 */
async function scan(page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  /** @param {import("axe-core").Result} v */
  const fmt = (v) =>
    `${v.id}: ${v.nodes.map((n) => n.target.join(" > ")).join(", ")}`;
  return {
    failing: results.violations.map(fmt),
  };
}

/**
 * Assert the bar is clean — maximum sensitivity: every violation fails,
 * regardless of impact. @param {Awaited<ReturnType<typeof scan>>} s
 * @param {string} label
 */
function assertClean(s, label) {
  expect(s.failing, `${label} violations`).toEqual([]);
}

/* ------------------------------------------------------------------ */
/* Code entry (unbound) — plain page, real front door, both themes.   */
/* ------------------------------------------------------------------ */

test.describe("code entry", () => {
  for (const scheme of THEMES) {
    test.describe(`theme: ${scheme}`, () => {
      test.use({ colorScheme: scheme });
      test(`a11y: code entry (${scheme})`, async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("wa-otp-input#code-input")).toBeVisible();
        await settle(page);
        assertClean(await scan(page), `code entry (${scheme})`);
      });
    });
  }
});

/* ------------------------------------------------------------------ */
/* Bound home (/today) and capture view — real bindSite flow via the  */
/* shared harness (fresh context + real code-entry binding per test). */
/* ------------------------------------------------------------------ */

test.describe("bound app", () => {
  for (const scheme of THEMES) {
    test.describe(`theme: ${scheme}`, () => {
      harnessTest.use({ colorScheme: scheme });
      harnessTest(`a11y: bound home (${scheme})`, async ({ page }) => {
        await expect(page.locator("#start-check")).toBeVisible();
        await settle(page);
        assertClean(await scan(page), `bound home (${scheme})`);
      });

      harnessTest(`a11y: capture view (${scheme})`, async ({ page }) => {
        await startCheck(page);
        await expect(page.locator("#add-photo")).toBeVisible();
        await settle(page);
        assertClean(await scan(page), `capture view (${scheme})`);
      });
    });
  }
});
