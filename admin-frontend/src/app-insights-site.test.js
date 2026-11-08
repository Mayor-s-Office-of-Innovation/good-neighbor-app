import { test, vi } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  focused,
  missing,
  pageError,
  settle,
  text,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { intervalOf } from "./pages/insights/insights-query.js";
import {
  formatInstant,
  perDayText,
  periodLabel,
  rangeLabel,
} from "./pages/insights/insights.templates.js";

const url = () => window.location.pathname + window.location.search;
/** @param {string} key */
const activity = (key) =>
  text(`[data-activity="${key}"] [data-activity-count]`);
/** @param {string} key */
const response = (key) =>
  text(`[data-response="${key}"] [data-response-count]`);
/** @param {string} key */
const band = (key) => text(`[data-band="${key}"] [data-band-count]`);
/** Each section has its own list; Issue Response Time's unless named. @param {string} [list] */
const listed = (list = "response") =>
  $$(`[data-list="${list}"] [data-issue-row]`).map(
    (row) => row.dataset.issueRow,
  );
/** @param {string} [list] */
const pressed = (list = "response") =>
  $$(`[data-list="${list}"] [data-tile]`)
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.dataset.tile);
/** The value each Issue list request sent for one filter; requests without it belong to the other list. @param {any} api @param {string} [param] */
const issueStates = (api, param = "responseState") =>
  api
    .calls("GET", /^reporting\/issues/)
    .map((/** @type {any} */ c) => new URLSearchParams(c.search).get(param))
    .filter(Boolean);
/** @param {(json: any) => void} change */
const siteReply = (change) => (/** @type {any} */ api) =>
  api.on("GET", /^reporting\/sites\/s1/, (/** @type {any} */ r) => {
    const reply = api.reply(r);
    change(reply.json);
    return reply;
  });

test("Site insights names the Site, its manager and its activity, in page order", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: siteReply((json) => {
      json.issuesPer30Days = 8.7;
    }),
  });
  assert.equal(text("h1"), "Example Site");
  assert.ok(focused("#insights-title"));
  assert.equal(
    text("[data-site-meta]"),
    // The manager's name, not the ID, once the names load.
    t("admin.insights.siteMeta.manager", { name: "Casey Manager" }),
  );
  assert.deepEqual(
    $$("[data-activity]").map((tile) => tile.dataset.activity),
    ["completedPerimeterChecks", "issuesCreated", "singleIssueReports"],
  );
  assert.deepEqual(
    // Rates lead where there is one.
    ["completedPerimeterChecks", "issuesCreated", "singleIssueReports"].map(
      (key) => text(`[data-activity="${key}"] [data-tile-n]`),
    ),
    [perDayText(2), t("admin.insights.per30d", { value: "8.7" }), "3"],
  );
  assert.equal(
    text("[data-insights-freshness]"),
    t("admin.insights.dataAsOf", {
      time: formatInstant("2026-11-04T18:00:00.000Z"),
    }),
  );
  // Concerns, then Contacts, Activity and Issue Response Time.
  const order = [
    "[data-site-concerns]",
    "#insights-contacts",
    "#insights-activity",
    "#insights-severe",
    "#insights-response",
  ].map((s) => $(s));
  for (let i = 1; i < order.length; i++)
    assert.ok(
      order[i - 1].compareDocumentPosition(order[i]) &
        window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
});

test("a blocked sign-in while the manager's name loads shows in the error line", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.fail("GET", /^oversight-options/, 403, "request_blocked"),
  });
  await settle();
  assert.equal(pageError(), t("admin.errors.requestBlocked"));
  assert.equal(text("h1"), "Example Site");
});

test("a Site with concerns says why, each with its count and where to look", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: siteReply((json) => {
      json.issuesPer30Days = 8.7;
    }),
  });
  assert.deepEqual(
    $$("[data-concern]").map((li) => li.dataset.concern),
    ["fewChecks", "repeatedSevere", "manyIssues", "slowResponse"],
  );
  assert.ok(
    text('[data-concern="fewChecks"]').includes(
      // s1 owes 4 a day, so its own number shows, not the citywide 3.
      t("admin.insights.concernWhy.fewChecks", { perDay: "2.0", min: 4 }),
    ),
  );
  assert.equal(
    $('[data-concern="fewChecks"] a').getAttribute("href"),
    "#insights-activity",
  );
  assert.ok(
    text('[data-concern="repeatedSevere"]').includes(
      t("admin.insights.concernWhy.repeatedSevere", { count: 2, min: 2 }),
    ),
  );
  assert.ok(
    text('[data-concern="manyIssues"]').includes(
      t("admin.insights.concernWhy.manyIssues", {
        count: 9,
        rate: "8.7",
        max: 4,
      }),
    ),
  );
  // One flag for slow responses, naming each part it found.
  assert.equal(
    text('[data-concern="slowResponse"]'),
    `${t("admin.insights.concern.slowResponse")}: ${[
      t("admin.insights.concernWhy.slowResponse.overdue", { count: 1 }),
      t("admin.insights.concernWhy.slowResponse.late", { count: 1 }),
      t("admin.insights.concernWhy.slowResponse.open", { count: 1, days: 14 }),
    ].join(", ")}. ${t("admin.insights.seeResponseTime")}`,
  );
  // Shows the number Few Checks is judged on, not only the total.
  assert.equal(
    text('[data-activity="completedPerimeterChecks"] [data-checks-per-day]'),
    perDayText(2),
  );
  // Severe Issues and slow response point at their own lists; other flags at Activity.
  assert.deepEqual(
    $$("[data-concern] a").map((a) => a.getAttribute("href")),
    [
      "#insights-activity",
      "#insights-severe",
      "#insights-activity",
      "#insights-response",
    ],
  );
  assert.equal(
    text('[data-concern="repeatedSevere"] a'),
    t("admin.insights.seeSevere"),
  );
});

test("Severe Issues counts each severity band and opens on Severe's Issues", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  assert.equal(text("#insights-severe"), t("admin.insights.severeIssues"));
  assert.deepEqual(["severe", "moderate", "minor", "unknown"].map(band), [
    "2",
    "3",
    "4",
    "0",
  ]);
  assert.ok(
    text('[data-band="severe"]').includes(t("admin.insights.severity.severe")),
  );
  assert.ok($('[data-band="severe"] [data-severity="severe"]'));
  assert.deepEqual(pressed("severity"), ["severe"]);
  assert.deepEqual(issueStates(api, "severityBand"), ["severe"]);
  assert.deepEqual(listed("severity"), ["t1"]);
});

test("a severity tile replaces the picked one and reloads only the Severe Issues list", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  await click('[data-list="severity"] [data-tile="moderate"]');
  assert.deepEqual(pressed("severity"), ["moderate"]);
  assert.deepEqual(issueStates(api, "severityBand"), ["severe", "moderate"]);
  // Pressing the picked tile again keeps it, so the list never goes empty.
  await click('[data-list="severity"] [data-tile="moderate"]');
  assert.deepEqual(pressed("severity"), ["moderate"]);
  assert.deepEqual(issueStates(api, "severityBand"), ["severe", "moderate"]);
  // Issue Response Time keeps its picks and list, and isn't asked again.
  assert.deepEqual([pressed(), listed()], [["overdue", "late"], ["t2"]]);
  assert.deepEqual(issueStates(api), ["overdue,late"]);
});

/** One Issue list row's cell, by column. @param {string} list @param {string} id @param {string} name */
const cell = (list, id, name) =>
  text(`[data-list="${list}"] [data-issue-row="${id}"] [data-issue-${name}]`);
const days = (/** @type {number} */ count) =>
  t("reports.issues.duration.days", { count });

test("both Site Issue lists are tables with the same column headings and no ID", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  const heads = [
    t("admin.insights.siteIssues.col.issue"),
    t("admin.insights.siteIssues.col.createdAt"),
    t("admin.insights.siteIssues.col.responseTime"),
    t("admin.insights.siteIssues.col.onTime"),
  ];
  for (const list of ["severity", "response"]) {
    assert.deepEqual(
      $$(`[data-list="${list}"] thead th[scope="col"]`).map((th) =>
        th.textContent.trim(),
      ),
      heads,
    );
    // Each cell names its column, for the phone card layout.
    assert.deepEqual(
      $$(`[data-list="${list}"] tbody tr [data-label]`).map(
        (c) => c.dataset.label,
      ),
      heads,
    );
  }
  assert.ok(
    !text('[data-list="severity"] [data-issue-row="t1"]').includes("t1"),
  );
  assert.ok(
    !text('[data-list="response"] [data-issue-row="t2"]').includes("t2"),
  );
});

test("each Site Issue row shows when it was created and how long the response took", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.equal(
    cell("severity", "t1", "created"),
    formatInstant("2026-10-02T17:00:00.000Z"),
  );
  // Created 2 Oct 17:00, first response 3 Oct 17:00.
  assert.equal(cell("severity", "t1", "took"), days(1));
  assert.equal(
    cell("response", "t2", "took"),
    t("admin.insights.siteIssues.noResponse"),
  );
  assert.ok(
    $(
      '[data-list="response"] [data-issue-row="t2"] [data-issue-took] [data-tone="muted"]',
    ),
  );
});

test("Site Issue rows and Activity link nowhere while Raw data has no records", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.deepEqual(listed(), ["t2"]);
  await click(
    '[data-list="response"] [data-issue-row="t2"] [data-issue-created]',
  );
  assert.equal(url(), "/insights/sites/s1?period=2026-10");
  assert.deepEqual(
    $$("[data-list] [data-issue-row] a, [data-charts] a").map((a) =>
      a.getAttribute("href"),
    ),
    [],
  );
});

/** Mounts with the Response list's Issue t2 changed. @param {Record<string, any>} change */
const withT2 = (change) =>
  mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        for (const issue of reply.json.issues)
          if (issue.issueId === "t2") Object.assign(issue, change);
        return reply;
      }),
  });

test("On Time? says On time for an Issue answered by its deadline", async () => {
  await withT2({
    responseState: "onTime",
    firstResponseAt: "2026-10-21T16:00:00.000Z",
  });
  assert.equal(
    cell("response", "t2", "on-time"),
    t("admin.insights.siteIssues.onTime"),
  );
  assert.equal(cell("response", "t2", "took"), days(1));
  assert.ok(
    missing('[data-list="response"] [data-issue-row="t2"] [data-tone="warn"]'),
  );
});

test("On Time? names the expected response time for a late Issue", async () => {
  await withT2({
    responseState: "late",
    firstResponseAt: "2026-10-25T16:00:00.000Z",
  });
  // Created 20 Oct 16:00 and due 23 Oct 16:00, so 3 days were allowed.
  assert.equal(
    cell("response", "t2", "on-time"),
    t("admin.insights.siteIssues.lateDueWithin", { expected: days(3) }),
  );
  assert.equal(cell("response", "t2", "took"), days(5));
  assert.ok(
    $(
      '[data-list="response"] [data-issue-row="t2"] [data-issue-on-time] [data-tone="warn"]',
    ),
  );
});

test("On Time? says Late for an Issue still unanswered past its deadline", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.equal(
    cell("response", "t2", "on-time"),
    t("admin.insights.siteIssues.lateDueWithin", { expected: days(3) }),
  );
});

test("On Time? says Not yet due for an Issue awaiting a response in time", async () => {
  await withT2({ responseState: "awaiting" });
  assert.equal(
    cell("response", "t2", "on-time"),
    t("admin.insights.siteIssues.notYetDue"),
  );
  assert.ok(
    missing('[data-list="response"] [data-issue-row="t2"] [data-tone="warn"]'),
  );
});

test("On Time? says No response time for an Issue its rule says to call 911 for", async () => {
  await withT2({ responseState: "notTimed", deadlineAt: null });
  assert.equal(
    cell("response", "t2", "on-time"),
    t("admin.insights.response.notTimed"),
  );
  assert.ok(
    missing(
      '[data-list="response"] [data-issue-row="t2"] [data-issue-on-time] [data-tone]',
    ),
  );
});

test("On Time? says Unknown for an Issue with no response record", async () => {
  await withT2({ responseState: "unknown", deadlineAt: null });
  assert.equal(
    cell("response", "t2", "on-time"),
    t("admin.insights.response.unknown"),
  );
  assert.ok(
    $(
      '[data-list="response"] [data-issue-row="t2"] [data-issue-on-time] [data-tone="unknown"]',
    ),
  );
});

test("a Site with no concerns has no Concerns box", async () => {
  await mountAdmin("/insights/sites/s3?period=2026-10", { insights: true });
  assert.ok(missing("[data-site-concerns]"));
});

test("contacts show the details on the Site's record, and a missing one says why", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) => {
      api.data.sites[0].publicContact = {
        email: "front@example.org",
        phone: "4155550100",
        phoneExtension: "12",
      };
    },
  });
  await settle();
  assert.equal(
    $('[data-contact="public"] a[href^="mailto:"]').getAttribute("href"),
    "mailto:front@example.org",
  );
  assert.equal(
    text('[data-contact="public"] a[href^="tel:"]'),
    "4155550100 ext. 12",
  );
  assert.ok(
    text('[data-contact="site"]').includes(
      t("admin.insights.reason.noSiteContact"),
    ),
  );
});

test("a Site contact on the record shows its name, email and phone", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) => {
      api.data.sites[0].primaryContact = {
        firstName: "Sam",
        lastName: "Rivera",
        email: "sam@example.org",
        phone: "4155550111",
      };
      siteReply((json) => {
        json.siteContact = { ...json.siteContact, state: "available" };
      })(api);
    },
  });
  await settle();
  assert.equal(text('[data-contact="site"] strong'), "Sam Rivera");
  assert.equal(
    $('[data-contact="site"] a[href^="mailto:"]').getAttribute("href"),
    "mailto:sam@example.org",
  );
});

test("when the Site's record can't be read, the public contact comes from the report", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) => {
      a.fail("GET", /^sites\/s1(\?|$)/, 403, "forbidden");
      siteReply((json) => {
        json.publicContact = {
          ...json.publicContact,
          email: "front-desk@example.org",
          phone: "4155550100",
        };
      })(a);
    },
  });
  await settle();
  assert.match(text('[data-contact="public"]'), /front-desk@example\.org/);
  assert.ok(missing('[data-contact="public"] [data-tone="warn"]'));
});

test("Edit site contacts opens the Site's details in a new tab", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  const link = $("#insights-edit-contacts");
  assert.deepEqual(
    [link.getAttribute("href"), link.getAttribute("target")],
    ["/sites/s1?section=details", "_blank"],
  );
  assert.ok(missing("#insights-manage-site"));
});

test("five response tiles count each state, and Overdue and Responded late list their Issues first", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  assert.deepEqual(
    ["overdue", "late", "awaiting", "onTime", "unknown"].map(response),
    ["1", "1", "1", "6", "0"],
  );
  assert.ok(missing('[data-response="notTimed"]'));
  assert.deepEqual(pressed(), ["overdue", "late"]);
  assert.deepEqual(issueStates(api), ["overdue,late"]);
  assert.deepEqual(listed(), ["t2"]);
});

test("picking a tile adds its Issues to the list, and picking it again takes them off", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  await click('[data-tile="onTime"]');
  assert.deepEqual(pressed(), ["overdue", "late", "onTime"]);
  assert.deepEqual(listed(), ["t2", "t1"]);
  await click('[data-tile="onTime"]');
  assert.deepEqual([pressed(), listed()], [["overdue", "late"], ["t2"]]);
  assert.deepEqual(issueStates(api), [
    "overdue,late",
    "overdue,late,onTime",
    "overdue,late",
  ]);
});

test("taking off every tile clears the list without asking for Issues", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  await click('[data-tile="overdue"]');
  await click('[data-tile="late"]');
  assert.deepEqual([pressed(), listed()], [[], []]);
  assert.ok(missing("[data-site-issues-empty]"));
  // Severe Issues' first list, Response's first list, then Responded late alone.
  assert.equal(api.calls("GET", /^reporting\/issues/).length, 3);
});

test("a tile with no Issues to list says so", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  // Awaiting alone, since the opening tiles have an Issue to list.
  await click('[data-tile="overdue"]');
  await click('[data-tile="late"]');
  await click('[data-tile="awaiting"]');
  assert.equal(
    text("[data-site-issues-empty]"),
    t("admin.insights.noTileIssues"),
  );
});

test("a Site with no Overdue or late Issues still opens with Overdue and Responded late picked", async () => {
  const { api } = await mountAdmin("/insights/sites/s3?period=2026-10", {
    insights: true,
  });
  assert.deepEqual(pressed(), ["overdue", "late"]);
  assert.deepEqual(issueStates(api), ["overdue,late"]);
});

test("a Site with no Issues says so", async () => {
  await mountAdmin("/insights/sites/s2?period=2026-10", { insights: true });
  assert.equal(
    text("[data-site-issues-empty]"),
    t("admin.insights.noIssuesInPeriod"),
  );
  assert.ok(missing("[data-tile]"));
});

test("a period before the data begins shows Unavailable, not zeros", async () => {
  await mountAdmin("/insights/sites/s1?period=2025-11", { insights: true });
  assert.equal(
    activity("completedPerimeterChecks"),
    t("admin.insights.unavailable"),
  );
  assert.equal(
    text("[data-site-issues-empty]"),
    t("admin.insights.empty.noIssueData"),
  );
});

test("a month shows Checks and Issues by day; a year shows them by month", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.deepEqual(
    $$("[data-charts] h3").map((h) => h.textContent),
    [
      t("admin.insights.chart.checks.day"),
      t("admin.insights.chart.issues.day"),
    ],
  );
  // October 2026 begins on a Thursday: three blank cells, then day 1.
  const first = $('[data-chart="checks"] table tr:nth-child(2)');
  assert.equal(first.querySelectorAll("td:empty").length, 3);
  await click('[data-period-kind="year"]');
  assert.deepEqual(
    $$("[data-charts] h3").map((h) => h.textContent),
    [
      t("admin.insights.chart.checks.month"),
      t("admin.insights.chart.issues.month"),
    ],
  );
  assert.equal($$('[data-chart="checks"] [data-bar]').length, 12);
});

test("a 404 that isn't a missing Site reads as a failure to retry", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) => a.fail("GET", /^reporting\/sites\//, 404, "not_found"),
  });
  assert.ok(missing('[data-insights-empty="site"]'));
  assert.ok(!missing("#insights-retry"));
});

test("Retry after a failed load shows the Site and its Issues", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) => a.fail("GET", /^reporting\/sites\//, 502, "reporting_failed"),
  });
  assert.equal(text("h1"), t("admin.insights.site"));
  api.on("GET", /^reporting\/sites\//, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-retry");
  assert.equal(text("h1"), "Example Site");
  // A month shows the daily rate as the headline and no total.
  assert.ok(
    !missing(
      '[data-activity="completedPerimeterChecks"] [data-checks-per-day]',
    ),
  );
  assert.deepEqual(listed(), ["t2"]);
});

test("a Site the reporting data doesn't have says so", async () => {
  await mountAdmin("/insights/sites/zz", { insights: true });
  assert.equal(
    text('[data-insights-empty="site"]'),
    t("admin.insights.siteNotFound"),
  );
});

test("when only the Issue list fails, the counts stay and it can retry", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) => a.fail("GET", /^reporting\/issues/, 502, "reporting_failed"),
  });
  // A month shows the daily rate as the headline and no total.
  assert.ok(
    !missing(
      '[data-activity="completedPerimeterChecks"] [data-checks-per-day]',
    ),
  );
  assert.ok(!missing("#insights-issues-retry"));
  api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-issues-retry");
  assert.deepEqual(listed(), ["t2"]);
  // Only the list is read again; the counts never left the screen.
  assert.equal(api.calls("GET", /^reporting\/sites\//).length, 1);
});

test("a list that arrives after the user picks another tile is dropped", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  const held = gate();
  api.on("GET", /^reporting\/issues/, async (/** @type {any} */ r) => {
    const reply = api.reply(r);
    if (new URLSearchParams(r.search).get("responseState") === "overdue")
      await held.promise;
    return reply;
  });
  // Taking off Responded late asks for Overdue alone, which is held.
  const late = click('[data-tile="late"]');
  await settle();
  await click('[data-tile="onTime"]');
  held.release();
  await late;
  await settle();
  assert.deepEqual(
    [pressed(), listed()],
    [
      ["overdue", "onTime"],
      ["t2", "t1"],
    ],
  );
});

test("the period opens from a button that names it, with its days beside it", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.equal(
    $("#insights-period-toggle").getAttribute("popovertarget"),
    "insights-period-pop",
  );
  assert.ok($("#insights-period-pop").contains($('[data-period-step="-1"]')));
  await click('[data-period-step="-1"]');
  const september = {
    kind: "month",
    startDay: "2026-09-01",
    endDay: "2026-10-01",
    incomplete: false,
  };
  assert.equal(text("[data-period-button]"), periodLabel(september));
  assert.equal(text("[data-period-range]"), rangeLabel(september));
});

test("changing the period keeps the return link in the URL", async () => {
  const back = "/insights?period=2026-10&show=all";
  await mountAdmin(
    `/insights/sites/s1?period=2026-10&return=${encodeURIComponent(back)}`,
    { insights: true },
  );
  await click('[data-period-step="-1"]');
  assert.equal(
    url(),
    `/insights/sites/s1?period=2026-09&return=${encodeURIComponent(back)}`,
  );
});

test("a public contact with an email only says which half is missing", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) => {
      api.fail("GET", /^sites\/s1(\?|$)/, 403, "forbidden");
      siteReply((json) => {
        json.publicContact = {
          ...json.publicContact,
          state: "missing",
          reasonCodes: ["no_phone"],
          email: "front-desk@example.org",
          phone: null,
        };
      })(api);
    },
  });
  await settle();
  const shown = text('[data-contact="public"]');
  assert.match(shown, /front-desk@example\.org/);
  assert.ok(
    shown.endsWith(
      `${t("admin.insights.contact.missing")}${t("admin.insights.reason.noPhone")}`,
    ),
  );
});

test("a contact reason the page has no words for shows the state alone", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) => {
      // The report's state shows only while the Site's record can't be read.
      api.fail("GET", /^sites\/s1(\?|$)/, 403, "forbidden");
      siteReply((json) => {
        json.siteContact.reasonCodes = ["a_reason_added_later"];
      })(api);
    },
  });
  await settle();
  assert.equal(
    text('[data-contact="site"]'),
    `${t("admin.insights.contacts.site")}${t("admin.insights.contact.missing")}`,
  );
});

test("a concern the page has no words for still shows as a concern", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: siteReply((json) => {
      json.concerns = ["a_rule_added_later"];
    }),
  });
  assert.equal(
    text("[data-site-concerns] li"),
    t("admin.insights.otherConcern"),
  );
});

const checksHelp = () =>
  text('[data-help="insights-tip-activity-completedPerimeterChecks"]');

test("the Checks help names the Site's own number a day", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  // s1 owes 4 a day.
  assert.equal(
    checksHelp(),
    t("admin.insights.activityHelp.completedPerimeterChecks", { min: 4 }),
  );
});

test("Few Checks shows the average it was flagged on, not the whole-days one", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    // Terms began mid-month: 3.2 a day over every day, 2.5 over the owed ones.
    setup: siteReply((json) => {
      json.checksPerDay = 3.2;
      json.checksOwedPerDay = 3;
      json.checksPerOwedDay = 2.5;
    }),
  });
  assert.ok(
    text('[data-concern="fewChecks"]').includes(
      t("admin.insights.concernWhy.fewChecks", { perDay: "2.5", min: 3 }),
    ),
  );
  assert.ok(!text('[data-concern="fewChecks"]').includes("3.2"));
});

test("the Checks help names no number for a Site that owed no Checks", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: siteReply((json) => {
      json.checksOwedPerDay = null;
      json.concerns = json.concerns.filter(
        (/** @type {string} */ c) => c !== "fewChecks",
      );
    }),
  });
  assert.equal(
    checksHelp(),
    t("admin.insights.activityHelp.completedPerimeterChecksNoneOwed"),
  );
  assert.ok(!checksHelp().includes("null"));
});

test("after Site insights fails to load, its period controls still work", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  api.fail("GET", /^reporting\/sites\//, 503, "snapshot_unavailable");
  await click('[data-period-step="1"]');
  assert.ok(!missing("#insights-retry"));
  api.on("GET", /^reporting\/sites\//, (/** @type {any} */ r) => api.reply(r));
  await click('[data-period-step="-1"]');
  assert.equal(url(), "/insights/sites/s1?period=2026-10");
  // A month shows the daily rate as the headline and no total.
  assert.ok(
    !missing(
      '[data-activity="completedPerimeterChecks"] [data-checks-per-day]',
    ),
  );
});

test("Overview in the breadcrumb shows the period picked on the Site", async () => {
  const back = "/insights?period=2026-10&show=all&cursor=50";
  await mountAdmin(
    `/insights/sites/s1?period=2026-10&return=${encodeURIComponent(back)}`,
    { insights: true },
  );
  await click('[data-period-step="-1"]');
  assert.equal(
    $("#insights-back").getAttribute("href"),
    "/insights?period=2026-09&show=all",
  );
});

test("a Site opened without a period names no month until the server picks one", async () => {
  const held = gate();
  await mountAdmin("/insights/sites/s1", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/sites\/s1/, async (/** @type {any} */ r) => {
        const reply = api.reply(r);
        await held.promise;
        return reply;
      }),
  });
  const shown = () => [
    text("[data-period-button]"),
    text("[data-period-range]"),
    $$("[data-period-step]").every((b) => b.disabled),
    missing("[data-period-incomplete]"),
  ];
  assert.deepEqual(shown(), [t("common.loading"), "", true, true]);
  held.release();
  await settle();
  const october = {
    kind: "month",
    startDay: "2026-10-01",
    endDay: "2026-11-01",
    incomplete: false,
  };
  assert.deepEqual(shown(), [
    periodLabel(october),
    rangeLabel(october),
    false,
    true,
  ]);
});

test("a Site that fails to load drops the old period's name, time and Issues", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  api.fail("GET", /^reporting\/sites\//, 404, "site_not_found");
  await click('[data-period-step="-1"]');
  assert.deepEqual(
    [text("h1"), text("[data-insights-freshness]"), listed()],
    [t("admin.insights.site"), t("admin.insights.dataAsOfPending"), []],
  );
});

test("an Issue with no category says it wasn't recorded", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        for (const issue of reply.json.issues) issue.category = null;
        return reply;
      }),
  });
  assert.ok(
    text('[data-issue-row="t2"]').includes(
      t("admin.insights.issue.categoryUnknown"),
    ),
  );
});

test("Issues per 30 days shows the server's rate, the one Many Issues is judged on", async () => {
  // 9 Issues over October's 31 days would be 8.7 if worked out here.
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: siteReply((json) => {
      json.issuesPer30Days = 3.3;
    }),
  });
  assert.equal(
    text('[data-activity="issuesCreated"] [data-issues-per-30d]'),
    t("admin.insights.per30d", { value: "3.3" }),
  );
});

test("a month shows the Checks and Issues totals under their rates", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: siteReply((json) => {
      json.issuesPer30Days = 8.7;
    }),
  });
  assert.deepEqual(
    [activity("completedPerimeterChecks"), activity("issuesCreated")],
    [
      t("admin.insights.raw.checksCount", { count: 62 }),
      t("admin.insights.raw.issuesCount", { count: 9 }),
    ],
  );
});

test("See Issue Response Time lists every Issue Slow response counts", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  await click('[data-concern="slowResponse"] a');
  const sent = new URLSearchParams(
    api.calls("GET", /^reporting\/issues/).at(-1).search,
  );
  assert.deepEqual(
    [sent.get("concern"), sent.get("siteIds"), sent.get("responseState")],
    ["slowResponse", "s1", null],
  );
  assert.deepEqual(pressed(), []);
  assert.equal(
    text('[data-concern-list="slowResponse"]'),
    t("admin.insights.concernList.slowResponse", { days: 14 }),
  );
  assert.deepEqual(listed(), ["t2", "t1"]);
  // A tile goes back to the tiles' own list.
  await click('[data-tile="awaiting"]');
  assert.deepEqual(pressed(), ["awaiting"]);
  assert.ok(missing("[data-concern-list]"));
  assert.equal(
    new URLSearchParams(
      api.calls("GET", /^reporting\/issues/).at(-1).search,
    ).get("responseState"),
    "awaiting",
  );
});

test("Load more adds the next Issues under the ones shown", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) =>
      a.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => {
        const params = new URLSearchParams(r.search);
        const cursor = params.get("cursor");
        params.delete("cursor");
        const reply = a.reply({ ...r, search: `?${params}` });
        if (!params.get("responseState")) return reply;
        const t1 = { ...reply.json.issues[0], issueId: "t1" };
        Object.assign(reply.json, {
          total: 2,
          issues: cursor ? [t1] : reply.json.issues,
          nextCursor: cursor ? null : "page-2",
        });
        return reply;
      }),
  });
  assert.equal(
    text('[data-list="response"] [data-issues-shown]'),
    t("admin.insights.issuesShown", { shown: 1, count: 2 }),
  );
  await click('[data-list="response"] [data-load-more]');
  assert.deepEqual(listed(), ["t2", "t1"]);
  assert.equal(
    new URLSearchParams(
      api.calls("GET", /^reporting\/issues/).at(-1).search,
    ).get("cursor"),
    "page-2",
  );
  assert.ok(missing('[data-list="response"] [data-load-more]'));
  assert.ok(missing('[data-list="response"] [data-issues-shown]'));
});

test("a Site that can't load before the server names a period still steps from this month", async () => {
  // 10 pm on 31 October in San Francisco is already November in UTC.
  vi.useFakeTimers({
    now: Date.parse("2026-11-01T05:00:00Z"),
    toFake: ["Date"],
  });
  await mountAdmin("/insights/sites/s1", {
    insights: true,
    setup: (a) => a.fail("GET", /^reporting\/sites\//, 502, "reporting_failed"),
  });
  const shown = intervalOf({ kind: "month", month: "2026-10" });
  assert.equal(text("[data-period-button]"), periodLabel(shown));
  assert.equal(
    /** @type {HTMLButtonElement} */ ($('[data-period-step="-1"]')).disabled,
    false,
  );
});

test("Back to Overview at another period still finds the Site's row", async () => {
  const back = "/insights?period=2026-10&show=all";
  await mountAdmin(
    `/insights/sites/s1?period=2026-09&return=${encodeURIComponent(back)}`,
    { insights: true },
  );
  await click("#insights-back");
  await settle();
  assert.equal(url(), "/insights?period=2026-09&show=all");
  assert.ok(!missing('[data-site-link="s1"]'));
  assert.ok(focused('[data-site-link="s1"]'));
});

test("the Site's contacts come from its own record, not its letters and staff", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  assert.deepEqual(
    api
      .calls("GET", /^sites\/s1(\?|$)/)
      .map((/** @type {any} */ c) => c.search),
    ["?view=settings"],
  );
});

test("while a new period loads, the old concerns and data time don't pass for the new one", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  const held = gate();
  api.on("GET", /^reporting\/sites\/s1/, async (/** @type {any} */ r) => {
    const reply = api.reply(r);
    await held.promise;
    return reply;
  });
  const stepping = click('[data-period-step="-1"]');
  await settle();
  assert.equal(
    text("[data-insights-freshness]"),
    t("admin.insights.dataAsOfPending"),
  );
  assert.ok($("[data-site-concerns]").closest("[inert]"));
  held.release();
  await stepping;
  await settle();
  assert.ok(!$("#insights-contacts").closest("[inert]"));
});

test("each Site Issue reads its severity apart from its category", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  const row = $('[data-list="response"] [data-issue-row="t2"] th');
  assert.ok(
    row.textContent
      .trim()
      .startsWith(`${t("admin.insights.severity.moderate")} `),
  );
});

test("a contact fixed in Manage since the report doesn't still read Missing", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) => {
      api.data.sites[0].publicContact = {
        email: "front@example.org",
        phone: "4155550100",
      };
      siteReply((json) => {
        json.publicContact = {
          state: "missing",
          reasonCodes: ["no_email"],
          email: null,
          phone: "4155550100",
        };
      })(api);
    },
  });
  await settle();
  assert.ok(text('[data-contact="public"]').includes("front@example.org"));
  assert.ok(missing('[data-contact="public"] [data-tone]'));
});

test("a Site contact with only a name on the record shows the name", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) => {
      api.data.sites[0].primaryContact = { firstName: "Sam", lastName: "Lee" };
    },
  });
  await settle();
  assert.equal(text('[data-contact="site"] strong'), "Sam Lee");
  assert.ok(missing('[data-contact="site"] [data-tone]'));
});
