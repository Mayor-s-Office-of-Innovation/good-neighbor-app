import { test } from "vitest";
import assert from "node:assert/strict";
import {
  $,
  $$,
  click,
  focused,
  missing,
  settle,
  text,
  window,
} from "../test-support/admin-dom.js";
import { mountAdmin } from "../test-support/app-mount.js";
import { gate } from "../../e2e/admin-tests/admin-mock.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { formatInstant } from "./pages/insights/insights.templates.js";

const url = () => window.location.pathname + window.location.search;
/** @param {string} key */
const activity = (key) => text(`[data-activity="${key}"] dd`);
/** @param {string} key */
const response = (key) =>
  text(`[data-response="${key}"] [data-response-count]`);

test("Site insights names the Site and shows its activity for the period", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.equal(text("h1"), "Example Site");
  assert.ok(focused("#insights-title"));
  assert.deepEqual(
    [
      activity("completedPerimeterChecks"),
      activity("singleIssueReports"),
      activity("issuesCreated"),
      activity("unfinishedChecks"),
    ],
    ["62", "3", "9", "1"],
  );
  assert.equal(
    text("[data-insights-freshness]"),
    t("admin.insights.dataAsOf", {
      time: formatInstant("2026-11-04T18:00:00.000Z"),
    }),
  );
});

test("Site insights counts each response state separately, with its meaning", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.deepEqual(
    ["overdue", "late", "awaiting", "onTime", "unknown", "notTimed"].map(
      response,
    ),
    ["1", "1", "1", "6", "0", "0"],
  );
  // "Call 911" rules set no response time, so they're never overdue.
  assert.ok(
    text('dl [data-response="notTimed"]').includes(
      t("admin.insights.responseHelp.notTimed"),
    ),
  );
  assert.ok(
    text('dl [data-response="overdue"]').includes(
      t("admin.insights.responseHelp.overdue"),
    ),
  );
});

test("Site insights says each contact's state and why it's missing", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  assert.equal(
    text('[data-contact="site"] dd'),
    `${t("admin.insights.contact.missing")} ${t("admin.insights.reason.noSiteContact")}`,
  );
  assert.equal(
    $("#insights-edit-contacts").getAttribute("href"),
    `/sites/s1?section=details&return=${encodeURIComponent("/insights/sites/s1?period=2026-10")}`,
  );
});

test("Site insights lists its Issues, each linking to its record with the Site", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  const [call] = api.calls("GET", /^reporting\/issues/);
  assert.equal(new URLSearchParams(call.search).get("siteIds"), "s1");
  assert.deepEqual(
    $$("[data-issue-row]").map((row) => row.dataset.issueRow),
    ["t1"],
  );
  assert.equal(
    $('[data-issue-row="t1"] a').getAttribute("href"),
    `/insights/raw/issues/t1?period=2026-10&siteId=s1&return=${encodeURIComponent("/insights/sites/s1?period=2026-10")}`,
  );
});

test("a Site with no Issues in the period says so", async () => {
  await mountAdmin("/insights/sites/s2?period=2026-10", { insights: true });
  assert.equal(
    text("[data-site-issues-empty]"),
    t("admin.insights.noIssuesInPeriod"),
  );
});

test("a period before the data begins says there's no data, not no Issues", async () => {
  await mountAdmin("/insights/sites/s1?period=2025-11", { insights: true });
  assert.equal(
    text("[data-site-issues-empty]"),
    t("admin.insights.empty.noIssueData"),
  );
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
  assert.ok($('[data-region="issues"]').hidden);
  api.on("GET", /^reporting\/sites\//, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-retry");
  assert.equal(text("h1"), "Example Site");
  assert.equal(activity("completedPerimeterChecks"), "62");
  // The failure hid the Issue list; the retry must show it again.
  assert.ok(!$('[data-issue-row="t1"]').closest("[hidden]"));
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
  assert.equal(activity("completedPerimeterChecks"), "62");
  assert.ok(!missing("#insights-issues-retry"));
  api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-issues-retry");
  assert.ok(!missing('[data-issue-row="t1"]'));
  // Only the list is read again; the counts never left the screen.
  assert.equal(api.calls("GET", /^reporting\/sites\//).length, 1);
  assert.equal(activity("completedPerimeterChecks"), "62");
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

test("Manage site leads to the Site's record with a way back to this period", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", { insights: true });
  await click('[data-period-step="-1"]');
  assert.equal(
    $("#insights-manage-site").getAttribute("href"),
    `/sites/s1?return=${encodeURIComponent("/insights/sites/s1?period=2026-09")}`,
  );
});

test("a way back that isn't Overview is not offered as Back to Overview", async () => {
  await mountAdmin(
    `/insights/sites/s1?period=2026-10&return=${encodeURIComponent("/insights/trends")}`,
    { insights: true },
  );
  assert.equal(
    $("#insights-back").getAttribute("href"),
    "/insights?period=2026-10",
  );
});

test("a public contact with an email only says which half is missing", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/sites\/s1/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        reply.json.publicContact = {
          ...reply.json.publicContact,
          state: "missing",
          reasonCodes: ["no_phone"],
        };
        return reply;
      }),
  });
  assert.equal(
    text('[data-contact="public"] dd'),
    `${t("admin.insights.contact.missing")} ${t("admin.insights.reason.noPhone")}`,
  );
});

test("a contact reason the page has no words for shows the state alone", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/sites\/s1/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        reply.json.siteContact.reasonCodes = ["a_reason_added_later"];
        return reply;
      }),
  });
  assert.equal(
    text('[data-contact="site"] dd'),
    t("admin.insights.contact.missing"),
  );
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
  assert.equal(activity("completedPerimeterChecks"), "62");
});

test("Back to Overview shows the period picked on the Site", async () => {
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

test("a user who moves on while the Issue list reloads keeps their place", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) => a.fail("GET", /^reporting\/issues/, 502, "reporting_failed"),
  });
  const held = gate();
  api.on("GET", /^reporting\/issues/, async (/** @type {any} */ r) => {
    await held.promise;
    return api.reply(r);
  });
  await click("#insights-issues-retry");
  $("#insights-back").focus();
  held.release();
  await settle();
  assert.ok(!missing('[data-issue-row="t1"]'));
  assert.ok(focused("#insights-back"));
});

test("a Site opened without a period goes back to Overview for this month", async () => {
  const back = "/insights?period=2026-08&show=all";
  await mountAdmin(`/insights/sites/s1?return=${encodeURIComponent(back)}`, {
    insights: true,
  });
  assert.equal($("#insights-back").getAttribute("href"), "/insights?show=all");
});

test("a Site that fails to load drops the old period's name, time and Issues", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
  });
  api.fail("GET", /^reporting\/sites\//, 404, "site_not_found");
  await click('[data-period-step="-1"]');
  assert.deepEqual(
    [
      text("h1"),
      text("[data-insights-freshness]"),
      $('[data-region="issues"]').hidden,
    ],
    [t("admin.insights.site"), t("admin.insights.dataAsOfPending"), true],
  );
});

test("an Issue with no category says it wasn't recorded", async () => {
  await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (api) =>
      api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => {
        const reply = api.reply(r);
        reply.json.issues[0].category = null;
        return reply;
      }),
  });
  const first = $$("[data-issue-row]")[0];
  assert.ok(
    first.textContent.includes(t("admin.insights.issue.categoryUnknown")),
  );
});

test("a user still on the heading after a retry keeps focus there", async () => {
  const { api } = await mountAdmin("/insights/sites/s1?period=2026-10", {
    insights: true,
    setup: (a) => a.fail("GET", /^reporting\/issues/, 502, "reporting_failed"),
  });
  api.on("GET", /^reporting\/issues/, (/** @type {any} */ r) => api.reply(r));
  await click("#insights-issues-retry");
  assert.ok(!missing('[data-issue-row="t1"]'));
  assert.ok(focused("#insights-site-issues"));
});
