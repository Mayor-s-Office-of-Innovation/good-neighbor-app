import { test } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { readOverview } from "./insights-query.js";
import { resultsView } from "./overview.templates.js";

const october = {
  kind: "month",
  startDay: "2026-10-01",
  endDay: "2026-11-01",
  incomplete: false,
};

/** @param {Record<string, unknown>} change */
const row = (change) => ({
  siteId: "s1",
  name: "Example Site",
  managerId: "",
  status: "active",
  activity: { issuesCreated: 3 },
  response: { overdue: 0, late: 0 },
  maxSeverity: 3,
  checksPerDay: 2,
  checksOwedPerDay: 4,
  checksPerOwedDay: 2,
  issuesPer30Days: 2.9,
  publicContact: { state: "available" },
  ...change,
});

/** @param {Record<string, unknown>[]} sites */
function table(sites) {
  const html = resultsView({
    reply: {
      sites,
      siteCount: sites.length,
      meta: {
        interval: october,
        dataQuality: { reasons: [], coverageStart: "2026-01-01" },
      },
    },
    state: readOverview(""),
    siteHref: (id) => `/insights/sites/${id}`,
    names: { managerId: new Map(), providerId: new Map() },
  });
  const box = document.createElement("div");
  box.innerHTML = html;
  return box;
}

test("Issues per 30 days shows the server's rate, with one decimal", () => {
  const box = table([row({ issuesPer30Days: 4.93 })]);
  assert.equal(box.querySelector("[data-issues-per-30d]")?.textContent, "4.9");
});

test("a Site with no rate from the server shows None, not zero", () => {
  const box = table([row({ issuesPer30Days: null })]);
  assert.ok(!box.querySelector("[data-issues-per-30d]"));
  assert.equal(
    box.querySelector("[data-issues-rate]")?.textContent,
    t("admin.insights.none"),
  );
});

test("a Site that owes no Checks shows its average with no target bar", () => {
  const box = table([
    row({ checksOwedPerDay: null, checksPerOwedDay: null, checksPerDay: 1.2 }),
  ]);
  assert.equal(box.querySelector("[data-checks-per-day]")?.textContent, "1.2");
  assert.ok(!box.querySelector("[data-checks-meter]"));
});

test("a Site that owes Checks gets a bar against its own daily number", () => {
  const box = table([row({})]);
  assert.equal(
    box.querySelector("[data-checks-meter]")?.getAttribute("aria-label"),
    t("admin.insights.checksMeter", { value: "2.0", owed: 4 }),
  );
});

test("Overdue or late says how many Issues have an unknown response, so 0 isn't read as all on time", () => {
  const box = table([row({ response: { overdue: 0, late: 0, unknown: 5 } })]);
  assert.equal(box.querySelector("[data-late-count]")?.textContent, "0");
  assert.equal(
    box.querySelector("[data-response-unknown]")?.textContent,
    "5 unknown",
  );
  assert.ok(!table([row({})]).querySelector("[data-response-unknown]"));
});

test("a manager's line carries their ID, so a late name fills in place", () => {
  const box = table([row({ managerId: "pm1" })]);
  assert.equal(box.querySelector('[data-manager="pm1"]')?.textContent, "pm1");
});

test("the view of Unknown Sites is named for the Unknown state the Site page shows, not Missing", () => {
  // Missing is a known gap, such as No public contact; this view lists unknowns only.
  assert.ok(
    t("admin.insights.show.unknown").startsWith(
      t("admin.insights.response.unknown"),
    ),
  );
});

test("a large late count is grouped, as Raw data's counts are", () => {
  const box = table([row({ response: { overdue: 1200, late: 34 } })]);
  assert.equal(box.querySelector("[data-late-count]")?.textContent, "1,234");
});
