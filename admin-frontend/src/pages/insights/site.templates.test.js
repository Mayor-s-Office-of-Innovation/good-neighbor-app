import { test } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { siteIssuesView } from "./site.templates.js";

const HOUR = 3_600_000;
const created = "2026-10-05T17:00:00.000Z";
/** @param {number} ms */
const after = (ms) => new Date(Date.parse(created) + ms).toISOString();

/** @param {Record<string, unknown>} change */
const issue = (change) => ({
  issueId: "t1",
  severity: 3,
  category: "",
  createdAt: created,
  firstResponseAt: after(2 * HOUR),
  deadlineAt: after(72 * HOUR),
  responseState: "onTime",
  ...change,
});

/**
 * One Issue row, drawn as the Site page draws it.
 * @param {Record<string, unknown>} change
 * @param {Record<string, unknown>} [page]
 * @param {string} [more]
 */
function drawn(change, page = {}, more = "") {
  const box = document.createElement("div");
  box.innerHTML = siteIssuesView({
    list: "response",
    issues: { issues: [issue(change)], total: 1, nextCursor: null, ...page },
    failed: "",
    tile: "onTime",
    more,
  });
  return box;
}

test("an Issue row names its severity in words, as Overview does", () => {
  const box = drawn({ severity: 5 });
  const sev = /** @type {HTMLElement} */ (
    box.querySelector('[data-severity="severe"]')
  );
  // Plain text, not a screen-reader-only span, so sighted users read it too.
  assert.deepEqual(
    [...sev.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent),
    [t("admin.insights.severity.severe")],
  );
});

test("a response with no recorded time reads Unknown, not No response", () => {
  const box = drawn({ firstResponseAt: null, responseState: "unknown" });
  assert.equal(
    box.querySelector("[data-issue-took]")?.textContent,
    t("admin.insights.response.unknown"),
  );
  assert.equal(
    drawn({ firstResponseAt: null, responseState: "overdue" }).querySelector(
      "[data-issue-took]",
    )?.textContent,
    t("admin.insights.siteIssues.noResponse"),
  );
});

test("a late response time never reads the same as its deadline", () => {
  const took = (/** @type {number} */ ms) =>
    drawn({
      firstResponseAt: after(ms),
      deadlineAt: after(4 * HOUR),
      responseState: "late",
    }).querySelector("[data-issue-took]")?.textContent;
  assert.deepEqual(
    [took(4 * HOUR + 20 * 60_000), took(4 * HOUR + 10_000), took(98 * HOUR)],
    [
      t("admin.insights.siteIssues.tookTwoUnits", {
        larger: t("reports.issues.duration.hours.other", { count: 4 }),
        smaller: t("reports.issues.duration.minutes.other", { count: 20 }),
      }),
      t("admin.insights.siteIssues.tookTwoUnits", {
        larger: t("reports.issues.duration.hours.other", { count: 4 }),
        smaller: t("reports.issues.duration.minutes.one", { count: 1 }),
      }),
      t("admin.insights.siteIssues.tookTwoUnits", {
        larger: t("reports.issues.duration.days.other", { count: 4 }),
        smaller: t("reports.issues.duration.hours.other", { count: 2 }),
      }),
    ],
  );
  // On time keeps the rounded time the rest of the app shows.
  assert.equal(
    drawn({ firstResponseAt: after(4 * HOUR + 20 * 60_000) }).querySelector(
      "[data-issue-took]",
    )?.textContent,
    t("reports.issues.duration.hours.other", { count: 4 }),
  );
});

test("Load more stays focusable while its page loads, so keyboard users keep their place", () => {
  const button = drawn(
    {},
    { nextCursor: "page-2", total: 2 },
    "loading",
  ).querySelector("[data-load-more]");
  assert.equal(button?.hasAttribute("disabled"), false);
  assert.equal(button?.getAttribute("aria-disabled"), "true");
});
