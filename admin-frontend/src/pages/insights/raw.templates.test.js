import { test } from "vitest";
import assert from "node:assert/strict";
import { t as translate } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { countWords, formatInstant } from "./insights.templates.js";
import { readRaw } from "./raw-query.js";
import {
  checksView,
  dayHeading,
  exportDialogView,
  exportWhyOff,
  fixedOptions,
  issueGroups,
  issueRow,
  issuesView,
  moreView,
  rawFiltersView,
} from "./raw.templates.js";
import { select } from "./overview.templates.js";
import {
  checkBodyView,
  issueBodyView,
  panelView,
  recordHeadView,
  recordTrailView,
} from "./record.templates.js";

// Markup escapes apostrophes, so copy is compared as the markup holds it.
/** @param {string} key @param {Record<string, string | number>} [params] */
const t = (key, params) => escapeHtml(translate(key, params));

const meta = {
  asOf: "2026-11-04T18:00:00.000Z",
  interval: {
    kind: "month",
    startDay: "2026-10-01",
    endDay: "2026-11-01",
    incomplete: false,
  },
  dataQuality: { reasons: [], coverageStart: "2026-01-01" },
};
const issue = {
  issueId: "t1",
  siteId: "s1",
  siteName: "Example Site",
  checkId: "c1",
  createdAt: "2026-10-02T17:00:00.000Z",
  createdDay: "2026-10-02",
  category: "Unsecured gate",
  severity: 4,
  deadlineAt: "2026-10-05T17:00:00.000Z",
  firstResponseAt: null,
  responseState: "overdue",
  resolvedAt: null,
  latestActivityAt: "2026-10-02T17:00:00.000Z",
};
const check = {
  checkId: "c1",
  siteId: "s1",
  siteName: "Example Site",
  source: "perimeter",
  state: "unfinished",
  startedAt: "2026-10-02T16:50:00.000Z",
  completedAt: null,
  activityAt: "2026-10-02T16:50:00.000Z",
  issues: 1,
};
const href = () => "/record";
/** @param {string} html */
const cells = (html) =>
  [...html.matchAll(/data-label="([^"]+)"/g)].map((m) => m[1]);

test("an Issue row's cells are each labelled for phones, with the severity dot beside the words", () => {
  const html = issueRow(issue, href);
  assert.deepEqual(
    cells(html),
    ["category", "site", "severity", "status", "response"].map((k) =>
      t(`admin.insights.raw.issue.${k}`),
    ),
  );
  // The dot only adds to the word, so screen readers skip it.
  assert.match(
    html,
    /data-severity="severe"[^>]*><span [^>]*aria-hidden="true">/,
  );
  assert.ok(html.includes(t("admin.insights.severity.severe")));
  // Overdue reads as a warning in words, not colour alone.
  assert.match(
    html,
    /data-response="overdue"><span [^>]*>([^<]*)<\/span><\/td>/,
  );
  assert.equal(
    html.match(/data-response="overdue"><span [^>]*>([^<]*)</)?.[1],
    t("admin.insights.response.overdue"),
  );
});

test("Issues group under the day they were created, the day of their latest activity, or their Site", () => {
  // Created on Friday, last touched the next Monday.
  const touched = { ...issue, latestActivityAt: "2026-10-05T17:00:00.000Z" };
  const headings = (/** @type {string} */ group) =>
    issueGroups([touched], group).map((g) => g.heading);
  assert.deepEqual(headings("created"), [dayHeading("2026-10-02")]);
  assert.deepEqual(headings("latest"), [dayHeading("2026-10-05")]);
  assert.deepEqual(headings("site"), ["Example Site"]);
  const html = issuesView({
    rows: [touched],
    reply: { meta, total: 1 },
    href,
    more: "",
    notice: "",
    stale: "",
    state: readRaw("issues", "?group=created"),
  });
  assert.ok(
    html.includes(`data-group-head>${escapeHtml(dayHeading("2026-10-02"))}<`),
  );
  assert.equal(
    dayHeading("2026-10-02"),
    translate("admin.insights.raw.dayHeading", {
      weekday: "Friday",
      date: "Oct 2",
    }),
  );
});

test("an empty list says why: no data, no match with Clear filters, or none", () => {
  const view = { rows: [], href, more: "", notice: "", stale: "" };
  const before = {
    ...meta,
    dataQuality: { reasons: ["before_coverage"], coverageStart: null },
  };
  assert.match(
    issuesView({
      ...view,
      reply: { meta: before },
      state: readRaw("issues", ""),
    }),
    /data-insights-empty="no-data"/,
  );
  const filtered = issuesView({
    ...view,
    reply: { meta },
    state: readRaw("issues", "?severityBand=minor"),
  });
  assert.match(filtered, /data-insights-empty="filtered"/);
  assert.match(filtered, /id="insights-clear-filters"/);
  assert.match(
    issuesView({ ...view, reply: { meta }, state: readRaw("issues", "") }),
    /data-insights-empty="none"/,
  );
  const checks = checksView({
    ...view,
    reply: { meta },
    state: readRaw("checks", "?state=unfinished"),
  });
  assert.ok(checks.includes(t("admin.insights.raw.noMatchTitle.checks")));
  assert.match(checks, /id="insights-clear-filters"/);
});

test("rows of one day stay in one group, and two Sites with one name stay apart", () => {
  const second = { ...issue, issueId: "t2" };
  const twin = { ...issue, issueId: "t3", siteId: "s2" };
  assert.deepEqual(
    issueGroups([issue, second, twin], "site").map((g) => [
      g.key,
      g.issues.length,
    ]),
    [
      ["s1", 2],
      ["s2", 1],
    ],
  );
});

test("an unfinished Check row says when it started, muted", () => {
  const html = checksView({
    rows: [check],
    reply: { meta, total: 1 },
    state: readRaw("checks", ""),
    href,
    more: "ready",
    notice: "",
    stale: "",
  });
  assert.match(
    html,
    new RegExp(
      `data-muted>${t("admin.insights.raw.startedAt", { time: formatInstant(check.startedAt) })}<`,
    ),
  );
  assert.match(html, /data-record-link="s1\|c1"/);
  assert.match(html, /id="insights-load-more"/);
});

test("big numbers are grouped, so 250000 reads as 250,000", () => {
  assert.equal(
    countWords("admin.insights.raw.issuesCount", 12_345, { period: "x" }),
    translate("admin.insights.raw.issuesCount", {
      count: 2,
      period: "x",
    }).replace("2", "12,345"),
  );
  assert.equal(
    countWords("admin.insights.raw.issuesCount", 1, { period: "x" }),
    translate("admin.insights.raw.issuesCount", { count: 1, period: "x" }),
  );
  assert.ok(
    moreView({ more: "ready", rows: [issue], reply: { total: 1500 } }).includes(
      t("admin.insights.raw.showing", { shown: "1", total: "1,500" }),
    ),
  );
});

test("the export dialog names the count and what the file holds, with Download CSV", () => {
  const html = exportDialogView({ kind: "checks", count: 12 });
  assert.ok(
    html.includes(t("admin.insights.export.title.checks", { count: 12 })),
  );
  assert.ok(
    html.includes(t("admin.insights.export.body.checks", { count: 12 })),
  );
  assert.ok(html.includes(`>${t("admin.insights.export.confirm")}<`));
});

test("each filter is named for what it filters, whatever value it shows", () => {
  const html = rawFiltersView(
    "issues",
    readRaw("issues", "?issueStatus=open"),
    {},
  );
  for (const name of ["siteIds", "providerId", "issueStatus", "severityBand"])
    assert.match(
      html,
      new RegExp(
        `data-filter="${name}"[^>]*aria-label="${t(`admin.insights.field.${name}`)}"`,
      ),
    );
  assert.ok(
    select("managerId", "All", [], "", { label: "Manager" }).includes(
      'aria-label="Manager" placeholder="All"',
    ),
  );
});

test("Unknown severity is listed, in words, only when a link asks for it", () => {
  const values = ["severe", "moderate", "minor"];
  assert.deepEqual(fixedOptions("severityBand", values, "unknown").at(-1), {
    value: "unknown",
    label: translate("admin.insights.severity.unknown"),
  });
  assert.equal(fixedOptions("severityBand", values, "").length, 3);
});

test("Export CSV says why it's off", () => {
  assert.equal(exportWhyOff(0), translate("admin.insights.export.nothing"));
  assert.equal(
    exportWhyOff(250_001),
    translate("admin.insights.export.tooMany", { max: "250,000" }),
  );
  assert.equal(exportWhyOff(3), "");
});

test("the panel offers the full record by the label it's given, and a labelled ×", () => {
  for (const label of [
    "admin.insights.panel.open",
    "admin.insights.panel.openRaw",
  ]) {
    const html = panelView({
      kind: "issue",
      full: { href: "/r", label: translate(label) },
    });
    assert.match(html, new RegExp(`id="insights-panel-full">${t(label)}<`));
    assert.match(
      html,
      new RegExp(`aria-label="${t("admin.insights.panel.issue")}"`),
    );
    assert.match(html, new RegExp(`aria-label="${t("common.close")}"`));
  }
});

test("the trail starts at Raw data and the list, or at Site insights", () => {
  const raw = recordTrailView({
    root: { href: "/list", label: translate("admin.insights.checks") },
    raw: "/insights/raw/checks?period=2026-10",
    fromSite: false,
    hops: [{ href: "/c1", label: "Check c1" }],
    current: "t1",
  });
  assert.match(
    raw,
    new RegExp(
      `href="/insights/raw/checks\\?period=2026-10" data-route data-crumb="raw">${t("admin.insights.raw")}</a>`,
    ),
  );
  assert.match(raw, /data-crumb="root">Checks<\/a>/);
  // Phones hide the trail, so one link back to the list stands in.
  assert.match(raw, /href="\/list" data-route data-crumb-back>/);
  assert.match(raw, /data-crumb="0">Check c1<\/a>/);
  assert.match(raw, /aria-current="page">t1</);
  const site = recordTrailView({
    root: {
      href: "/insights/sites/s1",
      label: translate("admin.insights.site"),
    },
    raw: "/insights/raw/issues",
    fromSite: true,
    hops: [],
    current: "t1",
  });
  assert.doesNotMatch(site, /data-crumb="raw"/);
  assert.match(
    site,
    new RegExp(`data-crumb="root">${t("admin.insights.site")}<`),
  );
});

test("an Issue's Response heading has its ? and names each response fact", () => {
  const html = issueBodyView({
    reply: {
      issue,
      check: {
        ...check,
        state: "completed",
        completedAt: "2026-10-02T17:00:00.000Z",
      },
    },
    checkHref: "/c1",
    level: 2,
    idPrefix: "x",
  });
  assert.match(
    html,
    new RegExp(
      `id="x-tip-response"[^>]*>${t("admin.insights.record.responseHelp")}<`,
    ),
  );
  for (const key of [
    "created",
    "deadline",
    "firstResponse",
    "responseState",
    "resolved",
  ])
    assert.match(
      html,
      new RegExp(`<dt>${t(`admin.insights.record.${key}`)}</dt>`),
    );
  assert.match(html, new RegExp(t("admin.insights.record.noResponse")));
  assert.match(
    html,
    new RegExp(`<h2>${t("admin.insights.record.actions")}</h2>`),
  );
});

test("a Check record's head and facts, and its Issues", () => {
  const reply = {
    check,
    issues: [issue],
    site: { siteId: "s1", name: "Example Site" },
  };
  const head = recordHeadView({
    kind: "check",
    id: "c1",
    reply,
    level: 1,
    siteHref: "/s",
  });
  assert.match(
    head,
    new RegExp(`<h1[^>]*>${t("admin.insights.check", { id: "c1" })}</h1>`),
  );
  assert.match(head, new RegExp(t("admin.insights.raw.source.perimeter")));
  const body = checkBodyView({ reply, issueHref: href, level: 2 });
  assert.match(
    body,
    new RegExp(t("admin.insights.record.issuesFrom", { count: 1 })),
  );
  assert.match(body, /data-issue-row="t1"/);
});

test("a completed Check with no recorded finish time says Not recorded, not Not finished", () => {
  const completed = (/** @type {Record<string, unknown>} */ change) => {
    const box = document.createElement("div");
    box.innerHTML = checkBodyView({
      reply: {
        check: { ...check, state: "completed", ...change },
        issues: [],
      },
      issueHref: href,
      level: 2,
    });
    return box.querySelector('[data-fact="completed"] dd')?.textContent;
  };
  assert.equal(
    completed({ completedAt: null }),
    t("admin.insights.raw.notRecorded"),
  );
  assert.equal(
    completed({ state: "unfinished", completedAt: null }),
    t("admin.insights.record.notCompleted"),
  );
});
