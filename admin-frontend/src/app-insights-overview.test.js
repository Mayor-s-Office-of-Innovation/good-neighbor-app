import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  fill,
  focused,
  missing,
  routeTo,
  settle,
  text,
  tick,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { pacificDateKey } from "../../frontend/src/i18n/dates.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import {
  formatDay,
  formatInstant,
} from "./pages/insights/insights.templates.js";
import { LINK_MS } from "./pages/insights/report-job.js";

const url = () => window.location.pathname + window.location.search;
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
 * An Overview reply with `count` copies of Example Site, for paging and
 * selection.
 * @param {number} count
 * @param {Record<string, unknown>} [extra]
 */
function manySites(count, extra = {}) {
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
      Object.assign(json, extra);
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

test("Overview opens on Top concerns for the current month", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  assert.deepEqual(lastOverviewCall(api), { show: "top", sort: "name" });
  assert.deepEqual(rows(), ["s1", "s4"]);
  assert.equal($('[data-show="top"]').getAttribute("aria-pressed"), "true");
});

test("Overview says when its data was updated and that the period is still running", async () => {
  await mountAdmin("/insights", { insights: true });
  assert.equal(
    text("[data-insights-freshness]"),
    t("admin.insights.dataAsOf", {
      time: formatInstant("2026-11-04T18:00:00.000Z"),
    }),
  );
  assert.equal(
    text("[data-insights-quality]"),
    t("admin.insights.quality.incomplete", {
      time: formatInstant("2026-11-04T19:00:00.000Z"),
    }),
  );
});

test("each Site row names its response states, contacts and concerns in words", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  assert.equal(
    cell("s1", '[data-response="overdue"]'),
    t("admin.insights.responseCount", {
      count: 1,
      state: t("admin.insights.response.overdue"),
    }),
  );
  assert.equal(
    cell("s1", '[data-contact="public"]'),
    t("admin.insights.contact.available"),
  );
  assert.equal(
    cell("s1", '[data-contact="site"]'),
    t("admin.insights.contact.missing"),
  );
  assert.ok(
    cell("s4", "[data-concerns]").includes(t("admin.insights.concern.severe")),
  );
  assert.ok(
    cell("s4", "[data-concerns]").includes(
      t("admin.insights.unknownEvidence.siteContact"),
    ),
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
  await fill('[data-select-site="s1"]', true);
  assert.equal(url(), "/insights?period=2026-10&show=all&selected=s1");
  await fill('wa-select[data-filter="responseState"]', "late");
  assert.equal(url(), "/insights?period=2026-10&show=all&responseState=late");
  assert.equal(lastOverviewCall(api).responseState, "late");
  assert.notDeepEqual(rows(), before);
  assert.deepEqual(rows(), ["s1", "s4"]);
});

test("a contact filter asks for that contact state", async () => {
  const { api } = await mountAdmin("/insights", { insights: true });
  await fill('wa-select[data-filter="publicContact"]', "missing");
  assert.equal(lastOverviewCall(api).publicContact, "missing");
  assert.deepEqual(rows(), ["s4"]);
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
  await mountAdmin("/insights?period=2026-10&responseState=late", {
    insights: true,
  });
  await click('[data-site-link="s4"]');
  assert.equal(text("h1"), "Pier Example Site");
  await click("#insights-back");
  assert.equal(url(), "/insights?period=2026-10&responseState=late");
  assert.ok(focused('[data-site-link="s4"]'));
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

/**
 * A two-page Overview of 5 copies of Example Site; page two is cursor c2.
 * Pages shorter than the server's 50 keep the test quick.
 * @param {any} api
 */
function twoPages(api) {
  api.on("GET", /^reporting\/overview/, (/** @type {any} */ request) => {
    const reply = api.reply({ ...request, search: "?show=all" });
    const second = new URLSearchParams(request.search).get("cursor") === "c2";
    const template = reply.json.sites[0];
    const start = second ? 2 : 0;
    reply.json.sites = Array.from({ length: second ? 3 : 2 }, (_, i) => ({
      ...template,
      siteId: `m${start + i + 1}`,
      name: `Many Site ${start + i + 1}`,
    }));
    Object.assign(reply.json, {
      siteCount: 5,
      offset: start,
      nextCursor: second ? null : "c2",
    });
    return reply;
  });
}

test("Next page asks for the next rows and Previous goes back", async () => {
  const { api } = await mountAdmin("/insights", {
    insights: true,
    setup: twoPages,
  });
  await click('[data-page="next"]');
  assert.equal(lastOverviewCall(api).cursor, "c2");
  assert.equal(
    text("#insights-count"),
    t("admin.insights.showing", { from: 3, to: 5, count: 5 }),
  );
  assert.equal($('[data-page="next"]').disabled, true);
  assert.ok(focused("#insights-count"));
  await click('[data-page="prev"]');
  assert.equal(lastOverviewCall(api).cursor, undefined);
});

test("a page reopened from its link counts from where it starts", async () => {
  await mountAdmin("/insights?cursor=c2", { insights: true, setup: twoPages });
  assert.equal(
    text("#insights-count"),
    t("admin.insights.showing", { from: 3, to: 5, count: 5 }),
  );
  assert.equal($('[data-page="prev"]').disabled, false);
});

test("a page from older data starts again at page one and says why", async () => {
  const { api } = await mountAdmin("/insights?cursor=c2", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^reporting\/overview\?.*cursor=c2/, {
        status: 409,
        json: { error: "snapshot_changed" },
      }),
  });
  assert.equal(lastOverviewCall(api).cursor, undefined);
  assert.equal(url(), "/insights");
  assert.equal(text("[data-insights-notice]"), t("admin.insights.restarted"));
});

test("select all keeps the Sites already picked and fills up to 10", async () => {
  await mountAdmin("/insights", { insights: true, setup: manySites(12) });
  await fill('[data-select-site="m12"]', true);
  await fill("#insights-select-all", true);
  const picked = $$("[data-select-site]")
    .filter((b) => b.checked)
    .map((b) => b.dataset.selectSite);
  assert.equal(picked.length, 10);
  assert.ok(picked.includes("m12"));
});

test("select all picks the first 10 Sites and blocks an 11th", async () => {
  await mountAdmin("/insights", { insights: true, setup: manySites(12) });
  await fill("#insights-select-all", true);
  const boxes = $$("[data-select-site]");
  assert.deepEqual(
    boxes.filter((b) => b.checked).map((b) => b.dataset.selectSite),
    Array.from({ length: 10 }, (_, i) => `m${i + 1}`),
  );
  assert.equal(boxes[10].disabled, true);
  assert.equal(
    text("#insights-report"),
    t("admin.insights.report.buttonCount", { count: 10 }),
  );
});

test("Make report asks first, then sends the Sites and period with a key", async () => {
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

test("a report in progress says so, then offers its download", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  assert.equal(
    text("#insights-report-status"),
    `${t("admin.insights.report.working", { count: 1 })} ${t("admin.insights.report.cancel")}`,
  );
  await tick(2000);
  assert.equal(
    $("#insights-report-download").getAttribute("href"),
    "/mock-downloads/insights-issues.csv",
  );
});

test("a report that can't start says why", async () => {
  await mountAdmin("/insights?period=2026-10", {
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
  assert.equal(
    text("[data-report-error]"),
    t("admin.insights.report.error.jobsUnavailable"),
  );
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
  await mountAdmin("/insights?q=nothing&responseState=late", {
    insights: true,
  });
  await click("#insights-clear-filters");
  assert.deepEqual(
    [
      $("#insights-search").value,
      $('wa-select[data-filter="responseState"]').value,
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
  await fill('wa-select[data-filter="responseState"]', "late");
  assert.equal(url(), "/insights?period=2026-08&responseState=late");
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

test("a report still running keeps the user on Cancel between status checks", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: stillRunning,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  assert.ok(focused("#insights-report-status"));
  const cancel = $("#insights-report-cancel");
  cancel.focus();
  await tick(2000);
  await tick(2000);
  assert.equal(statusChecks(api), 2);
  assert.ok($("#insights-report-cancel") === cancel);
  assert.ok(focused("#insights-report-cancel"));
});

test("Cancel stops a report still waiting to start", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await click("#insights-report-cancel");
  await tick(2000);
  assert.deepEqual(
    [api.calls("DELETE", /^reports\//).length, statusChecks(api)],
    [1, 0],
  );
  assert.equal(
    text("#insights-report-status"),
    t("admin.insights.report.cancelled"),
  );
});

test("Cancel stops a running report and says so", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: stillRunning,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  // One status check first, so the report is running when it's cancelled.
  await tick(2000);
  assert.equal(statusChecks(api), 1);
  await click("#insights-report-cancel");
  const checked = statusChecks(api);
  await tick(2000);
  assert.equal(api.calls("DELETE", /^reports\//).length, 1);
  assert.equal(statusChecks(api), checked);
  assert.equal(
    text("#insights-report-status"),
    t("admin.insights.report.cancelled"),
  );
});

test("a concern the page has no words for still reads as a concern", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    setup: overviewReply((json) => {
      json.sites[0].concerns = ["addedLater"];
      json.sites[0].unknownEvidence = [];
    }),
  });
  const first = $$("[data-site-row]")[0].dataset.siteRow;
  assert.equal(
    cell(first, "[data-concerns]"),
    t("admin.insights.otherConcern"),
  );
});

test("an old link past the last page says so and offers Previous", async () => {
  const { api } = await mountAdmin(
    "/insights?period=2026-10&show=all&cursor=c9",
    {
      insights: true,
      setup: overviewReply((json) => {
        json.sites = [];
        json.offset = 50;
        json.nextCursor = null;
      }),
    },
  );
  assert.equal(
    text('[data-insights-empty="past-end"]'),
    t("admin.insights.empty.pastEnd"),
  );
  await click('[data-page="prev"]');
  assert.equal(lastOverviewCall(api).cursor, undefined);
});

test("manager names that arrive while the user is in the table show once they leave it", async () => {
  const held = gate();
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^program-managers$/, async (/** @type {any} */ r) => {
        await held.promise;
        return api.reply(r);
      }),
  });
  $('[data-select-site="s1"]').focus();
  held.release();
  await settle();
  const casey = api.data.programManagers[0].firstName;
  assert.ok(focused('[data-select-site="s1"]'));
  assert.ok(!cell("s1", "th").includes(casey));
  $("#insights-search").focus();
  await settle();
  assert.ok(cell("s1", "th").includes(casey));
});

test("a reattached Overview still shows the report status", async () => {
  await mountAdmin("/insights?period=2026-10", { insights: true });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  const before = text("#insights-report-status");
  assert.ok(before !== "");
  const page = $("insights-overview");
  const parent = page.parentNode;
  parent.removeChild(page);
  parent.appendChild(page);
  await settle();
  assert.equal(text("#insights-report-status"), before);
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

test("after the first load fails, Year still shows this year", async () => {
  const { api } = await mountAdmin("/insights", {
    insights: true,
    setup: (api) =>
      api.fail("GET", /^reporting\/overview/, 503, "snapshot_unavailable"),
  });
  await click('[data-period-kind="year"]');
  assert.deepEqual(
    [lastOverviewCall(api).period, lastOverviewCall(api).year],
    ["year", pacificDateKey(new Date()).slice(0, 4)],
  );
});

test("when a fresh download link can't be fetched, the page says so", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  // The fake clock moves Date too, so the link runs out on schedule.
  await tick(LINK_MS);
  api.fail("GET", /^reports\/(?!insights$)/, 503, "network");
  await click("#insights-report-refresh");
  assert.ok(
    text("#insights-report-status").includes(
      t("admin.insights.report.refreshFailed"),
    ),
  );
  assert.ok(!missing("#insights-report-refresh"));
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
      t("admin.insights.issuesNoSeverity", { count: 2 }),
    );
  });
}

test("switching windows while names arrive leaves the table and focus alone", async () => {
  const held = gate();
  await mountAdmin("/insights?period=2026-10&show=all", {
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
  // A window blur: focus leaves the page, so nothing new takes it.
  box.dispatchEvent(
    new window.FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
  );
  await settle();
  assert.ok($('[data-select-site="s1"]') === box);
  assert.ok(focused('[data-select-site="s1"]'));
});

test("browser Back from a Site whose period changed returns to the page left", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    setup: twoPages,
  });
  await click('[data-page="next"]');
  const left = url();
  await click('[data-site-link="m3"]');
  await click('[data-period-step="-1"]');
  window.history.back();
  await settle();
  assert.equal(url(), left);
  assert.ok(focused('[data-site-link="m3"]'));
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

test("evidence the page has no words for still reads as unknown", async () => {
  await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
    setup: overviewReply((json) => {
      json.sites[0].concerns = [];
      json.sites[0].unknownEvidence = ["addedLater"];
    }),
  });
  const first = $$("[data-site-row]")[0].dataset.siteRow;
  assert.equal(
    cell(first, "[data-concerns]"),
    t("admin.insights.otherUnknownEvidence"),
  );
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
  await click("#insights-report-refresh");
  assert.equal(
    text("#insights-report-status"),
    t("admin.insights.report.error.jobNotFound"),
  );
});

test("Make report sends the Sites the dialog counted, even if picks change behind it", async () => {
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
  assert.equal($("#insights-select-all").disabled, true);
  await fill("#insights-select-all", true);
  assert.equal(url(), "/insights?period=2026-10");
  held.release();
  await settle();
  assert.equal($("#insights-select-all").disabled, false);
});

test("a page link the server can't read starts again at page one and says why", async () => {
  const { api } = await mountAdmin("/insights?cursor=c2", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^reporting\/overview\?.*cursor=c2/, {
        status: 400,
        json: { error: "invalid_cursor" },
      }),
  });
  assert.equal(lastOverviewCall(api).cursor, undefined);
  assert.equal(url(), "/insights");
  assert.equal(
    text("[data-insights-notice]"),
    t("admin.insights.restartedLink"),
  );
  assert.deepEqual(rows(), ["s1", "s4"]);
});

test("pressing the view already shown keeps the picks and asks for nothing", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10&show=all", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  const loads = overviewCalls(api).length;
  await click('[data-show="all"]');
  assert.equal(url(), "/insights?period=2026-10&show=all&selected=s1");
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

test("a ready report with no download link offers to fetch one", async () => {
  await mountAdmin("/insights?period=2026-10", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) => {
        const reply = a.reply(r);
        reply.json.job.downloadUrl = null;
        return reply;
      }),
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  await tick(2000);
  assert.ok(!missing("#insights-report-refresh"));
  assert.ok(missing("#insights-report-download"));
});

test("a report whose status can't be read says so, and shows its file once it can", async () => {
  const { api } = await mountAdmin("/insights?period=2026-10", {
    insights: true,
  });
  await fill('[data-select-site="s1"]', true);
  await click("#insights-report");
  await click("#insights-report-confirm");
  api.fail("GET", /^reports\/(?!insights$)/, 503, "reporting_failed");
  // Reads back off: 2, 4 then 8 seconds apart.
  for (const ms of [2000, 4000, 8000]) await tick(ms);
  assert.equal(
    text("[data-report-delayed]"),
    t("admin.insights.report.checkDelayed"),
  );
  api.on("GET", /^reports\/(?!insights$)/, (/** @type {any} */ r) =>
    api.reply(r),
  );
  await tick(16000);
  assert.ok(!missing("#insights-report-download"));
});
