import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  focused,
  missing,
  pageError,
  routeTo,
  settle,
  text,
  tick,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import {
  formatDay,
  formatInstant,
  monthOfToday,
  periodLabel,
} from "./pages/insights/insights.templates.js";
import {
  intervalOf,
  periodSearch,
  stepPeriod,
} from "./pages/insights/insights-query.js";
import { LINK_MS } from "./pages/insights/report-job.js";

const url = () => window.location.pathname + window.location.search;
/** @type {string[]} */
const downloads = [];
// A download link would navigate the test's window away from the page.
window.addEventListener("click", (/** @type {any} */ event) => {
  const link = event.target.closest?.('a[href^="/mock-downloads/"]');
  if (!link) return;
  event.preventDefault();
  downloads.push(link.getAttribute("href"));
});
/**
 * A click with modifier keys, as for a new tab; held back so the test window stays put.
 * @param {string} selector
 * @param {Record<string, boolean>} keys
 */
async function modifiedClick(selector, keys) {
  const stay = (/** @type {Event} */ event) => event.preventDefault();
  window.addEventListener("click", stay, true);
  $(selector).dispatchEvent(
    new window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...keys,
    }),
  );
  window.removeEventListener("click", stay, true);
  await settle();
}
const rows = () => $$("[data-site-row]").map((row) => row.dataset.siteRow);
/** @param {any} api */
const overviewCalls = (api) =>
  api
    .calls("GET", /^reporting\/overview/)
    .map((/** @type {any} */ c) =>
      Object.fromEntries(new URLSearchParams(c.search)),
    );
/** @param {any} api */
const lastOverviewCall = (api) => overviewCalls(api).at(-1);
/** @param {string} siteId @param {string} selector */
const cell = (siteId, selector) =>
  text(`[data-site-row="${siteId}"] ${selector}`);

/**
 * An Overview reply with `count` copies of Example Site, for selection.
 * @param {number} count
 */
function manySites(count) {
  /** @param {any} api */
  return (api) =>
    overviewReply((json, request) => {
      const template = api.reply({ ...request, search: "?show=all" }).json
        .sites[0];
      json.sites = Array.from({ length: count }, (_, i) => ({
        ...template,
        siteId: `m${i + 1}`,
        name: `Many Site ${i + 1}`,
      }));
      json.siteCount = count;
    })(api);
}

/**
 * Changes every Overview reply before the page sees it.
 * @param {(json: any, request: any) => void} change
 */
const overviewReply = (change) => (/** @type {any} */ api) =>
  api.on("GET", /^reporting\/overview/, (/** @type {any} */ r) => {
    const reply = api.reply(r);
    change(reply.json, r);
    return reply;
  });

test("Overview opens on Top concerns for the last full month", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  assert.deepEqual(lastOverviewCall(api), { show: "top", sort: "name" });
  assert.deepEqual(rows(), ["s1", "s4"]);
  // A finished month, so the page never opens on part of one.
  assert.ok(missing("[data-period-incomplete]"));
  assert.equal($('[data-show="top"]').getAttribute("aria-pressed"), "true");
});

/** A running period's data ends at the snapshot time. */
const runningToSnapshot = overviewReply((json) => {
  json.meta.interval.observedTo = json.meta.asOf;
});

test("Overview says when its data was updated and that a running period is still running", async () => {
  await mountAdmin("/insights?period=2026-11", {
    insights: true,
    setup: runningToSnapshot,
  });
  assert.equal(
    text("[data-insights-freshness]"),
    t("admin.insights.dataAsOf", {
      time: formatInstant("2026-11-04T18:00:00.000Z"),
    }),
  );
  // A running period is marked on the period control, not as a data problem.
  assert.equal(
    text("[data-period-incomplete]"),
    t("admin.insights.period.incomplete", {
      time: formatInstant("2026-11-04T18:00:00.000Z"),
    }),
  );
  assert.ok(missing("[data-insights-quality]"));
});

test("each Site row shows late responses, worst Issue and Issues per 30 days", async () => {
  await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: overviewReply((json) => {
      for (const row of json.sites) row.issuesPer30Days = 4.9;
    }),
  });
  assert.equal(cell("s1", "[data-late-count]"), "2");
  assert.equal(
    cell("s4", "[data-issues]"),
    t("admin.insights.severity.severe"),
  );
  assert.ok(missing("[data-site-row] [data-concerns]"));
  // The server's rate, so the column matches its Many Issues flag.
  assert.equal(cell("s4", "[data-issues-per-30d]"), "4.9");
  // Shows the number Few Checks is judged on, not only the total.
  assert.equal(cell("s4", "[data-checks-per-day]"), "0.4");
  // Contacts aren't columns; a missing public contact is a chip under the name.
  assert.ok(missing("[data-site-row] [data-contact]"));
  assert.equal(
    cell("s4", "[data-no-public]"),
    t("admin.insights.noPublicContact"),
  );
  assert.ok(missing('[data-site-row="s1"] [data-no-public]'));
});

test("a column header's ? explains it", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  const tip = $('[popovertarget="insights-tip-col-response"]');
  assert.equal(
    tip.getAttribute("aria-label"),
    t("admin.insights.helpFor", { topic: t("admin.insights.col.response") }),
  );
  assert.equal(
    text("#insights-tip-col-response"),
    t("admin.insights.colHelp.response"),
  );
});

test("a period before the data begins shows Unavailable, not zeros", async () => {
  await mountAdmin("/insights?period=2025-06&show=all", { insights: true });
  assert.deepEqual(
    ["[data-checks]", "[data-response-cell]", "[data-issues]"].map((c) =>
      cell("s1", c),
    ),
    Array(3).fill(t("admin.insights.unavailable")),
  );
});

test("All Sites lists every Site and keeps the choice in the URL", async () => {
  await mountAdmin("/insights", { insights: true });
  await click('[data-show="all"]');
  assert.equal(url(), "/insights?show=all");
  assert.deepEqual(rows(), ["s1", "s3", "s4", "s2"]);
});

test("Unknown data lists only Sites with unknown evidence", async () => {
  await mountAdmin("/insights", { insights: true });
  await click('[data-show="unknown"]');
  assert.deepEqual(rows(), ["s4"]);
});

test("a filter narrows the table, goes in the URL and clears the selection", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  const before = rows();
  // s4 is pm2's, so it's still listed after the filter.
  await fill('[data-select-site="s4"]', true);
  // Picks stay out of the URL, so a 1,000-Site pick can't overflow a link.
  assert.equal(url(), "/insights?period=2026-10&show=all");
  await fill('wa-select[data-filter="managerId"]', "pm2");
  assert.equal(url(), "/insights?period=2026-10&show=all&managerId=pm2");
  assert.equal(lastOverviewCall(api).managerId, "pm2");
  assert.notDeepEqual(rows(), before);
  assert.deepEqual(rows(), ["s4"]);
  // A new population starts unpicked, so a report can't carry a Site picked for another reason.
  assert.equal($('[data-select-site="s4"]').checked, false);
  assert.equal($("#insights-report").getAttribute("aria-disabled"), "true");
});

test("a compliance manager finds their own name first in the Manager filter", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    role: "compliance-manager",
  });
  await settle();
  const select = $('wa-select[data-filter="managerId"]');
  const items = [...select.children].map((el) =>
    el.tagName === "WA-DIVIDER" ? "--" : el.textContent,
  );
  // The fake API's profile is linked to manager pm1.
  const own = [...select.querySelectorAll("wa-option")].find(
    (o) => o.getAttribute("value") === "pm1",
  );
  assert.equal(items[0], t("admin.insights.filter.managerId"));
  assert.equal(items[1], own.textContent);
  assert.match(own.textContent, /\(me\)$/);
  assert.equal(items[2], "--");
  const others = items.slice(3);
  assert.deepEqual(
    others,
    [...others].sort((x, y) => x.localeCompare(y)),
  );
  assert.ok(missing("#insights-mine"));
  // Picking it shows their own Sites and keeps the choice in the URL; s4 is pm2's.
  await fill('wa-select[data-filter="managerId"]', "pm1");
  assert.equal(url(), "/insights?period=2026-10&show=all&managerId=pm1");
  assert.equal(lastOverviewCall(api).managerId, "pm1");
  assert.deepEqual(rows(), ["s1", "s3", "s2"]);
});

test("a supervisor, who manages no Sites, sees no (me) option", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await settle();
  const select = $('wa-select[data-filter="managerId"]');
  assert.doesNotMatch(select.textContent, /\(me\)/);
  assert.equal(select.querySelector("wa-divider"), null);
});

test("a blocked sign-in while the filters load shows in the error line", async () => {
  await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.fail("GET", /^reporting\/scope-options/, 403, "request_blocked"),
  });
  await settle();
  assert.equal(pageError(), t("admin.errors.requestBlocked"));
  // The table doesn't need the filter lists, so it still loads.
  assert.ok(rows().length > 0);
});

test("a filter list that fails for another reason leaves the error line empty", async () => {
  await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: (api) => api.fail("GET", /^reporting\/scope-options/, 500),
  });
  await settle();
  assert.equal(pageError(), "");
});

test("Overview names the exact interval under the count, and no version", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  assert.equal(
    text("[data-insights-interval]"),
    t("admin.insights.interval", {
      from: formatDay("2026-10-01"),
      to: formatDay("2026-11-01"),
    }),
  );
  assert.doesNotMatch(text("insights-overview"), /version|rulebook/i);
});

test("a running period's footer ends at the data time, as its period pill does", async () => {
  await mountAdmin("/insights?period=2026-11", {
    insights: true,
    setup: runningToSnapshot,
  });
  assert.equal(
    text("[data-insights-interval]"),
    t("admin.insights.intervalSoFar", {
      from: formatDay("2026-11-01"),
      // 18:00 UTC; the footer drops ":00" and the space before AM.
      to: "Nov 4, 10AM",
    }),
  );
});

test("a new period drops the old interval while it loads", async () => {
  const held = gate();
  await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/overview/, async (/** @type {any} */ r) => {
        if (new URLSearchParams(r.search).get("month") === "2026-09")
          await held.promise;
        return api.reply(r);
      }),
  });
  assert.ok(text("[data-insights-interval]"));
  await click('[data-period-step="-1"]');
  assert.equal(text("[data-insights-interval]"), "");
  held.release();
  await settle();
});

test("a new sort keeps the picks, since every Site is still listed", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click('[data-sort-key="issuesPer30Days"]');
  assert.equal(lastOverviewCall(api).sort, "issuesPer30Days");
  assert.ok($('[data-select-site="s1"]').checked);
});

test("a header's first click shows the worst Sites first; a second click flips it", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  const th = (/** @type {string} */ key) =>
    $(`[data-sort-key="${key}"]`).closest("th");
  assert.equal(th("name").getAttribute("aria-sort"), "ascending");
  await click('[data-sort-key="checksPerDay"]');
  // Fewest Checks first, the server's own first direction for this column.
  assert.equal(lastOverviewCall(api).sort, "checksPerDay");
  assert.equal(lastOverviewCall(api).dir, undefined);
  assert.equal(th("checksPerDay").getAttribute("aria-sort"), "ascending");
  assert.equal(th("name").getAttribute("aria-sort"), "none");
  // The redrawn header keeps focus, so its new order is read out.
  assert.ok(focused('[data-sort-key="checksPerDay"]'));
  await click('[data-sort-key="checksPerDay"]');
  assert.equal(lastOverviewCall(api).dir, "desc");
  assert.equal(
    url(),
    "/insights?period=2026-10&show=all&sort=checksPerDay&dir=desc",
  );
  assert.equal(th("checksPerDay").getAttribute("aria-sort"), "descending");
  await click('[data-sort-key="overdueLate"]');
  assert.equal(lastOverviewCall(api).dir, undefined);
  assert.equal(th("overdueLate").getAttribute("aria-sort"), "descending");
});

test("the controls read Search, Period, Site status, then Filter", async () => {
  await mountAdmin("/insights", { insights: true });
  assert.deepEqual(
    $$("[data-control-label]").map((l) => l.textContent),
    ["search", "period", "status", "filter"].map((k) =>
      t(`admin.insights.label.${k}`),
    ),
  );
  assert.deepEqual(
    $$("[data-region='filters'] [data-show]").map((b) => b.dataset.show),
    ["all", "top", "unknown"],
  );
  // Responses and contacts show on each row, so they have no filter.
  assert.deepEqual(
    $$("wa-select[data-filter]").map((el) => el.dataset.filter),
    ["managerId", "providerId", "department"],
  );
  assert.ok(missing("[data-period-range]"));
});

test("search waits for typing to stop, asks once and keeps focus in the box", async () => {
  const { api } = await mountAdmin("/insights?show=all", { insights: true });
  const before = overviewCalls(api).length;
  $("#insights-search").focus();
  await fill("#insights-search", "pi");
  await fill("#insights-search", "pier");
  assert.equal(overviewCalls(api).length, before);
  await tick(300);
  assert.equal(overviewCalls(api).length, before + 1);
  assert.equal(lastOverviewCall(api).q, "pier");
  assert.deepEqual(rows(), ["s4"]);
  assert.ok(focused("#insights-search"));
});

test("Next period moves a month on and stops at the running month", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  $('[data-period-step="1"]').focus();
  await click('[data-period-step="1"]');
  assert.equal(url(), "/insights?period=2026-11");
  assert.equal(lastOverviewCall(api).month, "2026-11");
  assert.equal($('[data-period-step="1"]').disabled, true);
  // Next is now disabled, so focus moves to Previous rather than the page.
  assert.ok(focused('[data-period-step="-1"]'));
});

test("Financial year opens on the July–June year the month falls in", async () => {
  const { api } = await mountAdmin("/insights?period=2026-03", {
    insights: true,
  });
  await click('[data-period-kind="financialYear"]');
  assert.equal(url(), "/insights?period=fy2025");
  assert.deepEqual(
    [lastOverviewCall(api).period, lastOverviewCall(api).startYear],
    ["financialYear", "2025"],
  );
});

test("a custom period over 12 months is refused before asking the server", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  await click('[data-period-kind="custom"]');
  await fill("#insights-period-from", "2025-09-01");
  await fill("#insights-period-to", "2026-09-01");
  await click("#insights-period-apply");
  assert.equal(
    text("[data-period-error]"),
    t("admin.insights.error.periodTooLong"),
  );
  assert.equal($("#insights-period-to").value, "2026-09-01");
  assert.equal(
    overviewCalls(api).filter((c) => c.period === "custom").length,
    0,
  );
});

test("a custom period sends its end as the next day and keeps its dates in the URL", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  await click('[data-period-kind="custom"]');
  await fill("#insights-period-from", "2026-09-01");
  await fill("#insights-period-to", "2026-09-30");
  await click("#insights-period-apply");
  assert.equal(url(), "/insights?period=custom&from=2026-09-01&to=2026-09-30");
  assert.deepEqual(
    [lastOverviewCall(api).from, lastOverviewCall(api).to],
    ["2026-09-01", "2026-10-01"],
  );
});

test("a period before any data says when data begins", async () => {
  await mountAdmin("/insights?period=2025-06&show=all", { insights: true });
  assert.ok(
    text("[data-insights-quality]").includes(
      t("admin.insights.empty.noData", { day: formatDay("2026-01-01") }),
    ),
  );
});

test("filters that match nothing offer to clear them", async () => {
  const { api } = await mountAdmin("/insights?q=nothing", { insights: true });
  assert.ok(!missing('[data-insights-empty="filtered"]'));
  await click("#insights-clear-filters");
  assert.equal(lastOverviewCall(api).q, undefined);
  assert.deepEqual(rows(), ["s1", "s4"]);
});

test("a Site's link keeps the period and leads back to this exact view", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", { insights: true });
  assert.equal(
    $('[data-site-link="s1"]').getAttribute("href"),
    `/insights/sites/s1?period=2026-10&return=${encodeURIComponent("/insights?period=2026-10&show=all")}`,
  );
});

test("Back to Overview from a Site restores the view and focuses that Site", async () => {
  await mountAdmin("/insights?period=2026-10&managerId=pm2", {
    insights: true,
  });
  await fill('[data-select-site="s4"]', true);
  await click('[data-site-link="s4"]');
  assert.equal(text("h1"), "Pier Example Site");
  await click("#insights-back");
  assert.equal(url(), "/insights?period=2026-10&managerId=pm2");
  assert.ok(focused('[data-site-link="s4"]'));
  assert.ok($('[data-select-site="s4"]').checked);
});

test("a failed load shows why, hides old rows and retries", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  api.fail("GET", /^reporting\/overview/, 503, "snapshot_unavailable");
  await click('[data-show="all"]');
  assert.deepEqual(rows(), []);
  assert.ok(
    text("[data-region='results'] [role='alert']").includes(
      t("admin.insights.error.snapshotUnavailable"),
    ),
  );
  api.on("GET", /^reporting\/overview/, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-retry");
  assert.equal(rows().length, 4);
});

test("Load more adds the next Sites to the same list, with no pager", async () => {
  await mountAdmin("/insights", { insights: true, setup: manySites(51) });
  assert.equal(rows().length, 50);
  assert.ok(missing("[data-page]"));
  // The count is every matching Site, not just the drawn rows.
  assert.equal(
    text("#insights-count"),
    t("admin.insights.siteCount", { count: 51 }),
  );
  await click("[data-more-sites]");
  assert.equal(rows().length, 51);
  assert.ok(missing("[data-more-sites]"));
  assert.ok(focused(`[data-site-link="${rows()[50]}"]`));
});

test("Quarter opens on the calendar quarter the month falls in", async () => {
  const { api } = await mountAdmin("/insights?period=2026-08", {
    insights: true,
  });
  await click('[data-period-kind="quarter"]');
  assert.equal(url(), "/insights?period=2026-Q3");
  assert.deepEqual(
    [
      lastOverviewCall(api).period,
      lastOverviewCall(api).year,
      lastOverviewCall(api).quarter,
    ],
    ["quarter", "2026", "3"],
  );
  await click('[data-period-step="1"]');
  assert.equal(url(), "/insights?period=2026-Q4");
});

test("a shared link that names a quarter opens that quarter", async () => {
  const { api } = await mountAdmin("/insights?period=2026-Q2", {
    insights: true,
  });
  assert.deepEqual(
    [lastOverviewCall(api).period, lastOverviewCall(api).quarter],
    ["quarter", "2"],
  );
  assert.equal(
    $('[data-period-kind="quarter"]').getAttribute("aria-pressed"),
    "true",
  );
});

test("select all sits in the table header and picks every Site, with no cap", async () => {
  // One past the old 50-Site cap.
  await mountAdmin("/insights", { insights: true, setup: manySites(51) });
  assert.ok($("thead").contains($("#insights-select-all")));
  await fill("#insights-select-all", true);
  const boxes = $$("[data-select-site]");
  assert.equal(boxes.filter((b) => b.checked).length, 50);
  assert.ok(boxes.every((b) => !b.disabled));
  // The Site past the first 50 rows is picked too, and shows ticked once drawn.
  assert.equal(
    text("#insights-report"),
    t("admin.insights.report.buttonCount", { count: 51 }),
  );
  await click("[data-more-sites]");
  const ticked = () => $$("[data-select-site]").filter((b) => b.checked).length;
  assert.equal(ticked(), 51);
  await fill("#insights-select-all", false);
  assert.equal(ticked(), 0);
});

test("the bar above the table has the count, then Generate report", async () => {
  await mountAdmin("/insights", { insights: true });
  const count = $("#insights-count");
  const report = $("#insights-report");
  const after = window.Node.DOCUMENT_POSITION_FOLLOWING;
  // The column headers sort the table, so there's no Sort menu.
  assert.ok(missing('wa-select[data-filter="sort"]'));
  assert.ok(count.compareDocumentPosition(report) & after);
  assert.ok(report.compareDocumentPosition($("[data-insights-table]")) & after);
  assert.equal(text("#insights-report"), t("admin.insights.report.button"));
});

test("the count says how many Sites of all are listed when a view narrows them", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  assert.equal(
    text("#insights-count"),
    t("admin.insights.siteCountOf", { count: 2, total: 4 }),
  );
  await click('[data-show="all"]');
  assert.equal(
    text("#insights-count"),
    t("admin.insights.siteCount", { count: 4 }),
  );
});

test("with no Sites picked, Generate report says why it's off and does nothing", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  const report = $("#insights-report");
  assert.equal(report.getAttribute("aria-disabled"), "true");
  const why = report.getAttribute("aria-describedby");
  assert.equal(text(`[id="${why}"]`), t("admin.insights.report.needSites"));
  await click("#insights-report");
  assert.ok(missing("#insights-report-dialog"));
  await fill('[data-select-site="s1"]', true);
  assert.equal(report.getAttribute("aria-disabled"), "false");
  assert.equal(text(`[id="${why}"]`), "");
  assert.deepEqual(api.calls("POST", /^reports\/insights$/), []);
});

test("clicking a row away from its controls opens the Site", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await click('[data-site-row="s4"] [data-checks]');
  assert.equal(text("h1"), "Pier Example Site");
});

test("Generate report asks first, then sends the Sites and period with a key", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  assert.equal($("#insights-report-dialog").open, true);
  assert.equal(api.calls("POST", /^reports\/insights$/).length, 0);
  await click("#insights-report-confirm");
  const posts = api.calls("POST", /^reports\/insights$/);
  assert.equal(posts.length, 1);
  const [sent] = posts;
  assert.deepEqual(sent.body, {
    siteIds: ["s1"],
    period: "month",
    month: "2026-10",
  });
  assert.match(sent.headers["idempotency-key"], /^[A-Za-z0-9_-]{8,128}$/);
});

test("a report in progress shows on its button, then a dialog offers the download", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  assert.equal(text("#insights-report"), t("admin.insights.report.generating"));
  assert.equal($("#insights-report").getAttribute("aria-disabled"), "true");
  assert.ok(focused("#insights-report"));
  await tick(2000);
  assert.equal($("#insights-report-done").open, true);
  assert.equal(
    text("#insights-report-done h2"),
    t("admin.insights.report.done"),
  );
  assert.equal(
    $("#insights-report-download").getAttribute("href"),
    "/mock-downloads/insights-issues.csv",
  );
  assert.equal(
    text("#insights-report"),
    t("admin.insights.report.buttonCount", { count: 1 }),
  );
  await click("#insights-report-download");
  assert.ok(missing("#insights-report-done"));
  assert.ok(focused("#insights-report"));
});

test("Close shuts the ready dialog, and a return to Overview doesn't show it again", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  await click('#insights-report-done button[value="close"]');
  assert.ok(missing("#insights-report-done"));
  const page = $("insights-overview");
  const parent = page.parentNode;
  parent.removeChild(page);
  parent.appendChild(page);
  await settle();
  assert.ok(missing("#insights-report-done"));
});

test("a report that can't start says why in the dialog, and Try again asks again", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("POST", /^reports\/insights$/, {
        status: 503,
        json: { error: "jobs_unavailable" },
      }),
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  assert.equal($("#insights-report-done").open, true);
  assert.equal(
    text("[data-job-error]"),
    t("admin.insights.report.error.jobsUnavailable"),
  );
  assert.ok(missing("#insights-report-download"));
  await click("#insights-report-retry");
  assert.equal(api.calls("POST", /^reports\/insights$/).length, 2);
  assert.deepEqual(api.calls("POST", /^reports\/insights$/)[1].body.siteIds, [
    "s1",
  ]);
});

test("cancelling the report dialog sends nothing", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click('#insights-report-dialog button[value="cancel"]');
  assert.deepEqual(api.calls("POST", /^reports\/insights$/), []);
  assert.ok(focused("#insights-report"));
});

test("the Sites-to-show buttons mark only the one chosen as on", async () => {
  await mountAdmin("/insights", { insights: true });
  const pressed = () =>
    $$("[data-region='filters'] [data-show]")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.dataset.show);
  const seen = [];
  for (const show of ["unknown", "all", "top"]) {
    await click(`[data-region='filters'] [data-show="${show}"]`);
    seen.push(pressed());
  }
  assert.deepEqual(seen, [["unknown"], ["all"], ["top"]]);
});

test("Clear filters also clears the search box and the filter choices", async () => {
  await mountAdmin("/insights?q=nothing&managerId=pm2", {
    insights: true,
  });
  await click("#insights-clear-filters");
  assert.deepEqual(
    [
      $("#insights-search").value,
      $('wa-select[data-filter="managerId"]').value,
    ],
    ["", ""],
  );
});

test("a refused custom period keeps the period shown for the next filter", async () => {
  await mountAdmin("/insights?period=2026-08", { insights: true });
  await click('[data-period-kind="custom"]');
  await fill("#insights-period-from", "2026-09-10");
  await fill("#insights-period-to", "2026-09-01");
  await click("#insights-period-apply");
  await fill('wa-select[data-filter="managerId"]', "pm2");
  assert.equal(url(), "/insights?period=2026-08&managerId=pm2");
});

test("after a failed load, the period controls still move to another period", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  api.fail("GET", /^reporting\/overview/, 503, "snapshot_unavailable");
  await click('[data-period-step="1"]');
  api.on("GET", /^reporting\/overview/, (/** @type {any} */ r) => api.reply(r));
  await click('[data-period-step="-1"]');
  assert.equal(url(), "/insights?period=2026-10");
  assert.equal(rows().length, 2);
});

test("the Insights tabs carry the period picked on the page", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await click('[data-period-step="-1"]');
  assert.equal(
    $('[data-insights-nav="trends"]').getAttribute("href"),
    "/insights/trends?period=2026-09",
  );
});

test("the Insights tab reopens Overview with the choices made on it", async () => {
  await mountAdmin("/insights", { insights: true });
  await click('[data-show="all"]');
  await click('#admin-modes a[data-mode="manage"]');
  await click('#admin-modes a[data-mode="insights"]');
  assert.equal(url(), "/insights?show=all");
});

/**
 * Every status check finds the report still running.
 * @param {any} api
 */
const stillRunning = (api) =>
  api.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) => {
    const reply = api.reply(r);
    Object.assign(reply.json.job, {
      state: "running",
      downloadUrl: null,
      result: null,
    });
    return reply;
  });

/** @param {any} api */
const statusChecks = (api) =>
  api.calls("GET", /^reports\/(?!insights$)/).length;

test("a report still running keeps its button busy, and pressing it asks for nothing", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: stillRunning,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  await tick(2000);
  assert.equal(statusChecks(api), 2);
  assert.equal(text("#insights-report"), t("admin.insights.report.generating"));
  await click("#insights-report");
  assert.ok(missing("#insights-report-dialog"));
  assert.ok(missing("#insights-report-done"));
  assert.equal(api.calls("POST", /^reports\/insights$/).length, 1);
});

test("manager names that arrive while the user is in the table fill in without moving focus", async () => {
  const held = gate();
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^program-managers$/, async (/** @type {any} */ r) => {
        await held.promise;
        return api.reply(r);
      }),
  });
  const box = $('[data-select-site="s1"]');
  box.focus();
  held.release();
  await settle();
  const casey = api.data.programManagers[0].firstName;
  assert.ok(cell("s1", "th").includes(casey));
  // Same box, not a redrawn copy, so focus never left it.
  assert.ok($('[data-select-site="s1"]') === box);
  assert.ok(focused('[data-select-site="s1"]'));
});

test("a reattached Overview still shows the report running, then its dialog", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: stillRunning,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  const page = $("insights-overview");
  const parent = page.parentNode;
  parent.removeChild(page);
  parent.appendChild(page);
  await settle();
  assert.equal(text("#insights-report"), t("admin.insights.report.generating"));
  api.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) =>
    api.reply(r),
  );
  await tick(2000);
  assert.equal($("#insights-report-done").open, true);
});

test("going back to the month on screen from Custom keeps the picks", async () => {
  const { api } = await mountAdmin("/insights?show=all", { insights: true });
  await fill('[data-select-site="s1"]', true);
  const loads = overviewCalls(api).length;
  await click('[data-period-kind="custom"]');
  await click('[data-period-kind="month"]');
  assert.equal(overviewCalls(api).length, loads);
  assert.ok($('[data-select-site="s1"]').checked);
});

const periodControl = () => ({
  label: text("[data-period-label]"),
  disabled: $$("[data-period-step], [data-period-kind]")
    .filter((b) => b.disabled)
    .map((b) => b.dataset.periodStep ?? b.dataset.periodKind),
  incomplete: !missing("[data-period-incomplete]"),
});

test("with no period in the link, the period control names no month until the server picks one", async () => {
  const held = gate();
  await mountAdmin("/insights", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/overview/, async (/** @type {any} */ r) => {
        const reply = api.reply(r);
        await held.promise;
        return reply;
      }),
  });
  assert.deepEqual(periodControl(), {
    label: t("common.loading"),
    disabled: ["month", "quarter", "year", "financialYear", "-1", "1"],
    incomplete: false,
  });
  held.release();
  await settle();
  // The fake API picks the server's default: the last full month, October.
  assert.deepEqual(periodControl(), {
    label: periodLabel({
      kind: "month",
      startDay: "2026-10-01",
      endDay: "2026-11-01",
      incomplete: false,
    }),
    disabled: [],
    incomplete: false,
  });
});

test("after the first load fails with no period, the period control falls back to this month", async () => {
  const { api } = await mountAdmin("/insights", {
    insights: true,
    setup: (api) =>
      api.fail("GET", /^reporting\/overview/, 503, "snapshot_unavailable"),
  });
  const month = monthOfToday();
  assert.deepEqual(periodControl(), {
    label: periodLabel(intervalOf(month)),
    // This month is still running, so there's no Next.
    disabled: ["1"],
    // No reply has said how far the data goes.
    incomplete: false,
  });
  // Retry still asks for the server's own default period.
  await click("#insights-retry");
  assert.equal(lastOverviewCall(api).month, undefined);
  await click('[data-period-step="-1"]');
  const previous = stepPeriod(month, -1);
  assert.equal(url(), `/insights?${periodSearch(previous)}`);
});

test("Download after the link runs out fetches a fresh one first", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  // The fake clock moves Date too, so the link runs out on schedule.
  await tick(LINK_MS);
  const reads = statusChecks(api);
  api.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) => {
    const reply = api.reply(r);
    reply.json.job.downloadUrl = "/mock-downloads/fresh.csv";
    return reply;
  });
  await click("#insights-report-download");
  assert.equal(statusChecks(api), reads + 1);
  assert.equal(downloads.at(-1), "/mock-downloads/fresh.csv");
  assert.ok(missing("#insights-report-done"));
});

test("when a fresh download link can't be fetched, the dialog says so and Download stays", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  await tick(LINK_MS);
  api.fail("GET", /^reports\/(?!insights$)/, 503, "network");
  await click("#insights-report-download");
  assert.equal($("#insights-report-done").open, true);
  assert.ok(
    text("#insights-report-done").includes(
      t("admin.insights.report.refreshFailed"),
    ),
  );
  assert.ok(!missing("#insights-report-download"));
});

test("Back to Overview after a period change on the Site focuses that Site", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", { insights: true });
  await click('[data-site-link="s4"]');
  await click('[data-period-step="-1"]');
  await click("#insights-back");
  assert.equal(url(), "/insights?period=2026-09&show=all");
  assert.ok(focused('[data-site-link="s4"]'));
});

for (const maxSeverity of [null, 0]) {
  test(`Issues with severity ${maxSeverity} say it isn't recorded, not a highest severity`, async () => {
    await mountAdmin("/insights?period=2026-10&show=all", {
      insights: true,
      setup: overviewReply((json) => {
        json.sites[0].maxSeverity = maxSeverity;
        json.sites[0].activity.issuesCreated = 2;
      }),
    });
    const first = $$("[data-site-row]")[0].dataset.siteRow;
    assert.equal(
      cell(first, "[data-issues]"),
      t("admin.insights.severity.unknown"),
    );
  });
}

test("browser Back from a Site whose period changed returns to the view left, with its picks", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", { insights: true });
  await fill('[data-select-site="s1"]', true);
  const left = url();
  await click('[data-site-link="s4"]');
  await click('[data-period-step="-1"]');
  window.history.back();
  await settle();
  assert.equal(url(), left);
  assert.ok(focused('[data-site-link="s4"]'));
  assert.ok($('[data-select-site="s1"]').checked);
});

test("a Site opened from elsewhere doesn't pull focus on a later Overview", async () => {
  // s1 was opened from Overview; s4 is then reached another way.
  await mountAdmin("/insights?period=2026-10&show=all", { insights: true });
  await click('[data-site-link="s1"]');
  await routeTo("/insights/sites/s4?period=2026-10");
  await click('[data-period-step="-1"]');
  await click("#insights-back");
  assert.equal(url(), "/insights?period=2026-09&show=all");
  assert.ok(!focused('[data-site-link="s1"]'));
});

test("a report the server no longer keeps says to make it again", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  // The fake clock moves Date too, so the link runs out on schedule.
  await tick(LINK_MS);
  api.fail("GET", /^reports\/(?!insights$)/, 404, "job_not_found");
  await click("#insights-report-download");
  assert.equal(
    text("[data-job-error]"),
    t("admin.insights.report.error.jobNotFound"),
  );
  assert.ok(!missing("#insights-report-retry"));
});

test("Generate report sends the Sites the dialog counted, even if picks change behind it", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await fill('[data-select-site="s4"]', true);
  await click("#insights-report-confirm");
  const [sent] = api.calls("POST", /^reports\/insights$/);
  assert.deepEqual(sent.body.siteIds, ["s1"]);
});

test("while new Sites load, select all can't pick the old ones", async () => {
  const held = gate();
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  api.on("GET", /^reporting\/overview/, async (/** @type {any} */ r) => {
    await held.promise;
    return api.reply(r);
  });
  await click('[data-show="top"]');
  // The old rows stay in view but inert, so nothing can pick them.
  assert.ok($("#insights-select-all").closest("[inert]"));
  assert.equal(url(), "/insights?period=2026-10");
  await fill("#insights-select-all", true);
  held.release();
  await settle();
  assert.equal($("#insights-select-all").disabled, false);
  assert.deepEqual(
    $$("[data-select-site]")
      .filter((b) => b.checked)
      .map((b) => b.dataset.selectSite),
    [],
  );
});

test("pressing the view already shown keeps the picks and asks for nothing", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  const loads = overviewCalls(api).length;
  await click('[data-show="all"]');
  assert.equal(url(), "/insights?period=2026-10&show=all");
  assert.ok($('[data-select-site="s1"]').checked);
  assert.equal(overviewCalls(api).length, loads);
});

test("a manager known only by a single name shows that name", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^program-managers$/, (/** @type {any} */ r) => {
        const reply = a.reply(r);
        for (const m of reply.json.programManagers) {
          m.name = `Named ${m.userId}`;
          delete m.firstName;
          delete m.lastName;
        }
        return reply;
      }),
  });
  assert.ok(cell("s1", "th").includes("Named pm1"));
});

test("a ready report with no download link yet fetches one on Download", async () => {
  let linked = false;
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) => {
        const reply = a.reply(r);
        if (!linked) reply.json.job.downloadUrl = null;
        return reply;
      }),
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  linked = true;
  const reads = statusChecks(api);
  await click("#insights-report-download");
  assert.equal(statusChecks(api), reads + 1);
  assert.ok(missing("#insights-report-done"));
});

test("a report whose status can't be read says so, keeps trying, and opens its dialog once it can", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  api.fail("GET", /^reports\/(?!insights$)/, 503, "reporting_failed");
  // Reads back off: 2, 4 then 8 seconds apart.
  const reads = [];
  for (const ms of [2000, 4000, 8000]) {
    await tick(ms);
    reads.push(statusChecks(api));
  }
  assert.deepEqual(reads, [1, 2, 3]);
  assert.equal(text("#insights-report"), t("admin.insights.job.cantCheck"));
  assert.ok(missing("#insights-report-done"));
  api.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) =>
    api.reply(r),
  );
  await tick(16000);
  assert.ok(!missing("#insights-report-download"));
});

test("changing a filter keeps the old rows until the new ones arrive, so the page doesn't jump to the top", async () => {
  const held = gate();
  let hold = false;
  await mountAdmin("/insights", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/overview/, async (/** @type {any} */ r) => {
        const reply = api.reply(r);
        if (hold) await held.promise;
        return reply;
      }),
  });
  const before = rows();
  hold = true;
  await fill('wa-select[data-filter="managerId"]', "pm2");
  assert.deepEqual(rows(), before);
  assert.ok(missing('[role="status"] wa-spinner'));
  held.release();
  await settle();
  assert.notDeepEqual(rows(), before);
});

test("a Site opened in a new tab doesn't pull focus on a later load", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", { insights: true });
  await modifiedClick('[data-site-link="s1"]', { metaKey: true });
  assert.equal(url(), "/insights?period=2026-10&show=all");
  await click('[data-show="top"]');
  assert.ok(!focused('[data-site-link="s1"]'));
});

/** Holds every Overview reply after the first until `held` is released. @param {{ promise: Promise<unknown> }} held */
const holdLaterLoads = (held) => (/** @type {any} */ api) => {
  let first = true;
  api.on("GET", /^reporting\/overview/, async (/** @type {any} */ r) => {
    const reply = api.reply(r);
    if (!first) await held.promise;
    first = false;
    return reply;
  });
};

test("while a new view loads, the count is blank, not the old view's", async () => {
  const held = gate();
  await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: holdLaterLoads(held),
  });
  assert.equal(
    text("#insights-count"),
    t("admin.insights.siteCountOf", { count: 2, total: 4 }),
  );
  await click('[data-show="all"]');
  assert.equal(text("#insights-count"), "");
  held.release();
  await settle();
  assert.equal(
    text("#insights-count"),
    t("admin.insights.siteCount", { count: 4 }),
  );
});

test("opening a column's ? doesn't send focus to the count on a later load", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  const tip = '[popovertarget="insights-tip-col-response"]';
  $(tip).focus();
  await click(tip);
  await click('[data-show="all"]');
  assert.ok(!focused("#insights-count"));
});

test("a row click with a modifier key, or after selecting text, stays on Overview", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await modifiedClick('[data-site-row="s4"] [data-checks]', { ctrlKey: true });
  assert.equal(url(), "/insights?period=2026-10");
  const name = $('[data-site-row="s4"] th');
  window.getSelection().selectAllChildren(name);
  await click('[data-site-row="s4"] [data-checks]');
  assert.equal(url(), "/insights?period=2026-10");
  window.getSelection().removeAllRanges();
  await click('[data-site-row="s4"] [data-checks]');
  assert.equal(text("h1"), "Pier Example Site");
});

test("every column but the open arrow sorts the table", async () => {
  await mountAdmin("/insights", { insights: true });
  const options = $$("[data-sort-key]").map((b) =>
    b.textContent.replace(/[↑↓↕]/g, "").trim(),
  );
  const heads = ["site", "checks", "response", "severity", "issuesPer30d"].map(
    (col) => t(`admin.insights.col.${col}`),
  );
  assert.deepEqual(options, heads);
});
