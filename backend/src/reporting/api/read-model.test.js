import { describe, expect, it } from "vitest";
import {
  LIST_FILTERS,
  SORTS,
  parseListQuery,
  parsePeriodParams,
} from "./requests.js";
import {
  CONCERN_RULES,
  checkDetail,
  dataQuality,
  exportRowCount,
  exportRows,
  issueDetail,
  listChecks,
  listIssues,
  SITE_ROW_FILTERS,
  overview,
  reportDataset,
  scopeOptions,
  siteDetail,
  trends,
} from "./read-model.js";
import { indexSnapshot } from "./snapshot.js";
import { TEST_EVALUATED_AT, syntheticProjection } from "./test-projection.js";

/** @typedef {import("./snapshot.js").Snapshot} Snapshot */

const NOW = Date.parse("2026-11-04T20:00:00.000Z");
const { manifest, tables } = syntheticProjection();
const snap = indexSnapshot({ prefix: "p1", manifest, tables });
const october = parsePeriodParams(
  { period: "month", month: "2026-10" },
  TEST_EVALUATED_AT,
  snap.dataDays,
);
const november = parsePeriodParams(
  { period: "month", month: "2026-11" },
  TEST_EVALUATED_AT,
  snap.dataDays,
);

/**
 * @param {"sites" | "issues" | "checks"} kind
 * @param {Record<string, unknown>} [params]
 */
const list = (kind, params = {}) => parseListQuery(kind, params);

/**
 * A snapshot built from edited synthetic tables.
 * @param {(t: Record<string, any[]>, m: Record<string, any>) => void} edit
 */
function edited(edit) {
  const { tables, manifest } = syntheticProjection();
  edit(/** @type {any} */ (tables), manifest);
  return indexSnapshot({ prefix: "p1", manifest, tables });
}

describe("dataQuality", () => {
  it("is ok for a fresh snapshot over a covered period", () => {
    expect(dataQuality(snap, october, NOW)).toMatchObject({
      state: "ok",
      reasons: [],
    });
  });

  it("flags a snapshot over six hours old as stale, without blocking", () => {
    const later = Date.parse("2026-11-05T00:01:00.000Z");
    expect(dataQuality(snap, october, later)).toMatchObject({
      state: "stale",
      reasons: ["stale_snapshot"],
    });
  });

  it("flags a period that starts before any record as partial", () => {
    const august = parsePeriodParams(
      { period: "month", month: "2026-08" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    expect(dataQuality(snap, august, NOW)).toMatchObject({
      state: "partial",
      reasons: ["before_coverage"],
      coverageStart: "2026-09-15",
    });
  });

  it("lists open Sites with no compliance terms as a data gap", () => {
    const s = edited((_, m) => {
      m.dataQuality = { ...m.dataQuality, openSitesWithoutTerms: 2 };
    });
    expect(dataQuality(s, october, NOW)).toMatchObject({
      state: "partial",
      reasons: ["sites_without_terms"],
    });
  });

  it("flags Issues left out for having no usable time as partial", () => {
    const s = edited((_, m) => {
      m.dataQuality = { ...m.dataQuality, undated: 1 };
    });
    expect(dataQuality(s, october, NOW)).toMatchObject({
      state: "partial",
      reasons: ["undated_issues"],
    });
  });
});

describe("overview", () => {
  it("names no rule version when the snapshot didn't record one", () => {
    const s = edited((_, m) => {
      delete m.ruleVersion;
    });
    const res = overview(s, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    });
    expect(res.meta.ruleVersion).toBeNull();
  });

  it.each(Object.keys(SORTS.sites))("accepts the %s sort", (sort) => {
    const res = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites", { sort }),
      now: NOW,
    });
    expect(res.sites).toHaveLength(3);
  });

  it("sorts names the way people read them, whatever the case", () => {
    const s = edited((t) => {
      t.sites[0].name = "the Ark";
      t.sites[1].name = "Zion House";
      t.sites[2].name = "apple St";
    });
    const res = overview(s, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    });
    expect(res.sites.map((r) => r.name)).toEqual([
      "apple St",
      "the Ark",
      "Zion House",
    ]);
  });

  it.each(["asc", "desc"])(
    "puts a Site with no Issues last, even sorted %s",
    (dir) => {
      const res = overview(snap, {
        interval: october,
        filter: {},
        list: list("sites", { sort: "maxSeverity", dir }),
        now: NOW,
      });
      expect(res.sites.at(-1)?.siteId).toBe("s3");
    },
  );

  it("gives no basis for a Site with no contact record", () => {
    const s = edited((t) => {
      t.site_contacts = t.site_contacts.filter((c) => c.siteId !== "s3");
    });
    const res = overview(s, {
      interval: october,
      filter: { siteIds: ["s3"] },
      list: list("sites"),
      now: NOW,
    });
    expect(res.sites[0].publicContact).toMatchObject({
      state: "unknown",
      basis: null,
    });
  });

  it("says how much of the prior period has data", () => {
    const args = { filter: {}, list: list("sites"), now: NOW };
    const oct = overview(snap, { ...args, interval: october });
    const nov = overview(snap, { ...args, interval: november });
    // Records start 2026-09-15, halfway through October's prior month.
    expect([
      oct.comparison.priorCoverage,
      nov.comparison.priorCoverage,
    ]).toEqual(["partial", "full"]);
  });

  it("totals activity and response states for every Site in the period", () => {
    const res = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    });
    expect(res.totals).toEqual({
      activity: {
        completedPerimeterChecks: 4,
        singleIssueReports: 1,
        unfinishedChecks: 0,
        issuesCreated: 4,
        severeIssues: 2,
      },
      response: {
        awaiting: 0,
        overdue: 1,
        onTime: 2,
        late: 1,
        unknown: 0,
        notTimed: 0,
      },
    });
    expect(res.siteCount).toBe(3);
  });

  it("compares a finished month with the whole month before", () => {
    const res = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    });
    expect(res.comparison).toMatchObject({
      basis: "complete_period",
      sameDaysAsTotals: true,
    });
    expect(res.comparison.change?.completedPerimeterChecks).toEqual({
      current: 4,
      prior: 1,
      change: 3,
    });
  });

  it("compares a partial month with the same finished days of the month before", () => {
    const res = overview(snap, {
      interval: november,
      filter: {},
      list: list("sites"),
      now: NOW,
    });
    // Totals count today; the comparison leaves it out on both sides.
    expect(res.comparison).toMatchObject({
      basis: "elapsed_complete_days",
      days: 3,
      sameDaysAsTotals: false,
    });
    expect(res.comparison.change?.issuesCreated).toEqual({
      current: 1,
      prior: 1,
      change: 0,
    });
  });

  it("gives each Site its own counts, contacts and a Manage link, with no score", () => {
    const res = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    });
    const s1 = res.sites[0];
    expect(s1).toMatchObject({
      siteId: "s1",
      maxSeverity: 5,
      response: { overdue: 1, onTime: 2 },
      publicContact: { state: "available", basis: "current" },
      siteContact: { state: "available" },
      manageHref: "/sites/s1",
    });
    expect(Object.keys(s1)).not.toContain("compliant");
  });

  it("limits Sites to the filter", () => {
    const res = overview(snap, {
      interval: october,
      filter: { department: "Other Department" },
      list: list("sites"),
      now: NOW,
    });
    expect(res.sites.map((s) => s.siteId)).toEqual(["s2"]);
    expect(res.totals.activity.completedPerimeterChecks).toBe(1);
  });

  it("finds Sites by part of their name", () => {
    const res = overview(snap, {
      interval: october,
      filter: { q: "site 3" },
      list: list("sites"),
      now: NOW,
    });
    expect(res.sites.map((s) => s.siteId)).toEqual(["s3"]);
  });

  it("returns only the selected Sites, even when asked for others", () => {
    const res = overview(snap, {
      interval: october,
      filter: { siteIds: ["s2", "s9"] },
      list: list("sites"),
      now: NOW,
    });
    expect(res.sites.map((s) => s.siteId)).toEqual(["s2"]);
  });

  it("sorts by overdue and late Issues together, ties by name", () => {
    // s1 has one overdue, s2 one late, s3 neither.
    const res = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites", { sort: "overdueLate", dir: "asc" }),
      now: NOW,
    });
    // The cell's number only: s1's long-unresolved Issue doesn't break the tie.
    expect(
      res.sites.map((s) => [
        s.siteId,
        s.response.overdue + s.response.late,
        s.longUnresolved,
      ]),
    ).toEqual([
      ["s3", 0, 0],
      ["s1", 1, 1],
      ["s2", 1, 0],
    ]);
  });

  it("sorts the Checks and Issues columns by the rates they show, not by totals", () => {
    // s2 opens Oct 30 and has one Check and three Issues on Oct 31: fewer than s1 in total, at a higher rate.
    const opened = edited((t) => {
      for (const site of t.sites) site.hasPerimeter = true;
      t.sites[1].createdAt = "2026-10-30T20:00:00.000Z";
      t.site_days = t.site_days.filter((d) => d.siteId !== "s2");
      t.site_days.push({
        siteId: "s2",
        day: "2026-10-31",
        completedPerimeterChecks: 1,
        issuesCreated: 3,
      });
    });
    const fy = parsePeriodParams(
      { period: "financialYear", startYear: "2026" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    /** @param {string} sort @param {string} dir */
    const sorted = (sort, dir) =>
      overview(opened, {
        interval: fy,
        filter: {},
        list: list("sites", { sort, dir }),
        now: NOW,
      }).sites.map((r) => [
        r.siteId,
        sort === "checksPerDay" ? r.checksPerDay : r.issuesPer30Days,
      ]);
    expect([
      sorted("checksPerDay", "desc"),
      sorted("issuesPer30Days", "desc"),
    ]).toEqual([
      [
        ["s2", 0.3],
        ["s1", 0.1],
        ["s3", 0],
      ],
      [
        ["s2", 3],
        ["s1", 2.4],
        ["s3", 0],
      ],
    ]);
  });

  /**
   * October's Overview with list filters, as the page asks for it.
   * @param {Record<string, unknown>} params
   * @param {Snapshot} [from]
   */
  const shown = (params, from = snap) =>
    overview(from, {
      interval: october,
      filter: {},
      list: list("sites", params),
      now: NOW,
    });

  // s3 reopens with a public and a Site contact, so only its activity can flag it.
  const s3Contacted = (/** @type {string} */ state = "available") =>
    edited((t) => {
      t.sites[2].status = "active";
      const row = t.site_contacts.find((c) => c.siteId === "s3");
      row.publicContact = state;
      row.siteContact = state;
    });

  it("lists why each Site is a top concern, and what evidence is unknown", () => {
    // s1: two Severe Issues, one Overdue and one open since early October; s2: one late.
    const rows = shown({}, s3Contacted("unknown")).sites;
    expect(rows.map((r) => [r.siteId, r.concerns, r.unknownEvidence])).toEqual([
      ["s1", ["repeatedSevere", "slowResponse"], []],
      ["s2", ["slowResponse"], []],
      ["s3", [], ["publicContact", "siteContact"]],
    ]);
    expect(rows.map((r) => r.longUnresolved)).toEqual([1, 0, 0]);
  });

  it("keeps each threshold as a named rule, the same one the pages explain", () => {
    expect(CONCERN_RULES).toEqual({
      severeIssues: 2,
      issuesPer30Days: 4,
      unresolvedDays: 14,
    });
  });

  /**
   * One Site's flags for a period.
   * @param {Snapshot} from
   * @param {typeof october} interval
   * @param {string} siteId
   */
  const flagsOf = (from, interval, siteId) =>
    overview(from, {
      interval,
      filter: {},
      list: list("sites"),
      now: NOW,
    }).sites.find((r) => r.siteId === siteId)?.concerns;

  /** s1's count of Issues open over 14 days in October. @param {Snapshot} from */
  const longOpen = (from) =>
    overview(from, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    }).sites.find((r) => r.siteId === "s1")?.longUnresolved;

  /** @param {string} from @param {string} to exclusive */
  const days = (from, to) =>
    parsePeriodParams(
      { period: "custom", from, to },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );

  it("needs 2 or more Severe Issues for Repeated Severe Issues", () => {
    // Oct 1–4 holds only t1, Severe; October also holds t3.
    expect([
      flagsOf(snap, days("2026-10-01", "2026-10-05"), "s1"),
      flagsOf(snap, october, "s1"),
    ]).toEqual([["slowResponse"], ["repeatedSevere", "slowResponse"]]);
  });

  /** s1 with `count` Issues created Oct 1–10, a period under 30 days. @param {number} count */
  const issuesInTenDays = (count) =>
    edited((t) => {
      const row = t.site_days.find(
        (d) => d.siteId === "s1" && d.day === "2026-10-02",
      );
      row.issuesCreated = count - 1;
    });

  it("flags Many Issues over 4 per 30 days, and still over 4 in a shorter period", () => {
    const tenDays = days("2026-10-01", "2026-10-11");
    expect([
      flagsOf(issuesInTenDays(4), tenDays, "s1")?.includes("manyIssues"),
      flagsOf(issuesInTenDays(5), tenDays, "s1")?.includes("manyIssues"),
    ]).toEqual([false, true]);
  });

  it("scales Many Issues to every day its Issues are counted on, today included", () => {
    // Sep 21 to Nov 4 is 45 days, so 4 × 45 / 30 = 6 are allowed; 44 whole days would allow only 5.9.
    const long = days("2026-09-21", "2026-11-05");
    const busy = (/** @type {number} */ count) =>
      flagsOf(issuesInTenDays(count), long, "s1")?.includes("manyIssues");
    // Besides those, s1 has t2 and t3 in October and t4 in November.
    expect([busy(4), busy(5)]).toEqual([false, true]);
  });

  it("sends the Issues per 30 days the Many Issues flag compares, so the two agree", () => {
    const long = days("2026-09-21", "2026-11-05");
    const rows = [3, 4, 5, 6, 7].map(
      (count) =>
        overview(issuesInTenDays(count), {
          interval: long,
          filter: { siteIds: ["s1"] },
          list: list("sites"),
          now: NOW,
        }).sites[0],
    );
    // 5 to 9 Issues over 45 days.
    expect(
      rows.map((r) => [r.issuesPer30Days, r.concerns.includes("manyIssues")]),
    ).toEqual([
      [3.3, false],
      [4, false],
      [4.7, true],
      [5.3, true],
      [6, true],
    ]);
  });

  it("spreads Issues per 30 days over the days since the records or the Site began, not the whole year", () => {
    const fy = parsePeriodParams(
      { period: "financialYear", startYear: "2026" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    /** @param {Snapshot} from */
    const row = (from) =>
      overview(from, {
        interval: fy,
        filter: { siteIds: ["s1"] },
        list: list("sites"),
        now: NOW,
      }).sites[0];
    // Records begin Sep 15; s1 also logs 2 Issues on that partial first day.
    const busy = edited((t) => {
      t.site_days.find(
        (d) => d.siteId === "s1" && d.day === "2026-10-02",
      ).issuesCreated = 30;
      t.site_days.push({ siteId: "s1", day: "2026-09-15", issuesCreated: 2 });
    });
    const addedSep25 = edited((t) => {
      t.site_days.find(
        (d) => d.siteId === "s1" && d.day === "2026-10-02",
      ).issuesCreated = 30;
      t.site_days.push({ siteId: "s1", day: "2026-09-25", issuesCreated: 2 });
      t.sites[0].createdAt = "2026-09-25T20:00:00.000Z";
    });
    const [fromRecords, fromSite] = [row(busy), row(addedSep25)];
    // The Checks average's start, the day after: Sep 16 to Nov 4 is 50 days,
    // not the 127 since Jul 1. Added Sep 25: Sep 26 to Nov 4 is 40 days.
    // Neither counts the 2 Issues on its partial first day.
    expect([fromRecords.issuesPer30Days, fromSite.issuesPer30Days]).toEqual([
      Math.round(((fromRecords.activity.issuesCreated - 2) * 300) / 50) / 10,
      Math.round(((fromSite.activity.issuesCreated - 2) * 300) / 40) / 10,
    ]);
  });

  it("leaves activity from before a Site was added out of its totals", () => {
    const early = edited((t) => {
      t.sites[0].createdAt = "2026-10-15T20:00:00.000Z";
    });
    const row = overview(early, {
      interval: october,
      filter: { siteIds: ["s1"] },
      list: list("sites"),
      now: NOW,
    }).sites[0];
    // Of s1's October Issues, only t3 (Oct 20, Severe) comes after Oct 15.
    expect([
      row.activity.issuesCreated,
      row.activity.severeIssues,
      row.maxSeverity,
    ]).toEqual([1, 1, 5]);
  });

  it("counts the same days in totals, comparison, Trends and the Issues list for a Site added mid-period", () => {
    const early = edited((t) => {
      t.sites[0].createdAt = "2026-10-15T20:00:00.000Z";
    });
    const filter = { siteIds: ["s1"] };
    const ov = overview(early, {
      interval: october,
      filter,
      list: list("sites"),
      now: NOW,
    });
    const tr = trends(early, {
      interval: october,
      scope: filter,
      breakdown: "department",
      now: NOW,
    });
    const issues = listIssues(early, {
      interval: october,
      filter,
      list: list("issues"),
      now: NOW,
    });
    // Only t3 (Oct 20) comes after Oct 15, on every view of the month.
    expect({
      totals: ov.totals.activity.issuesCreated,
      comparison: ov.comparison.change?.issuesCreated.current,
      weeks: tr.series.current.reduce((n, b) => n + b.issuesCreated, 0),
      categories: tr.categories.reduce((n, c) => n + c.issues, 0),
      breakdown: tr.breakdown?.[0].current.issuesCreated,
      list: issues.total,
    }).toEqual({
      totals: 1,
      comparison: 1,
      weeks: 1,
      categories: 1,
      breakdown: 1,
      list: 1,
    });
  });

  it("can flag Many Issues on a period's first day, before any whole day", () => {
    const firstDay = edited((t, m) => {
      m.evaluatedAt = "2026-11-01T17:00:00.000Z";
      // Nothing after Nov 1 has happened yet.
      t.site_days = t.site_days.filter((d) => d.day < "2026-11-02");
      t.site_days.push({ siteId: "s1", day: "2026-11-01", issuesCreated: 5 });
    });
    const row = overview(firstDay, {
      interval: november,
      filter: { siteIds: ["s1"] },
      list: list("sites"),
      now: NOW,
    }).sites[0];
    expect([row.issuesPer30Days, row.concerns]).toEqual([5, ["manyIssues"]]);
  });

  /** s1's open, answered t1, created `ms` before the snapshot was evaluated. @param {number} ms */
  const openFor = (ms) =>
    edited((t) => {
      const t1 = t.issues.find((i) => i.issueId === "t1");
      t1.createdAt = new Date(Date.parse(TEST_EVALUATED_AT) - ms).toISOString();
    });

  it("flags an Issue created in the period and still open over 14 days at the data update", () => {
    const fourteenDays = CONCERN_RULES.unresolvedDays * 86_400_000;
    expect([
      longOpen(openFor(fourteenDays)),
      longOpen(openFor(fourteenDays + 1)),
    ]).toEqual([0, 1]);
  });

  /** s1's t1, resolved this many days after it was created. @param {number} n */
  const resolvedAfter = (n) =>
    edited((t) => {
      const t1 = t.issues.find((i) => i.issueId === "t1");
      t1.resolvedAt = new Date(
        Date.parse(t1.createdAt) + n * 86_400_000,
      ).toISOString();
    });

  it("times a resolved Issue to its resolution, so a past period's count stays put", () => {
    expect([longOpen(resolvedAfter(13)), longOpen(resolvedAfter(15))]).toEqual([
      0, 1,
    ]);
  });

  it("leaves overdue and late Issues out of long unresolved, so none counts twice", () => {
    // t2 is Overdue and open since Oct 10; t1 was answered on time but is still open.
    const s1 = shown({}).sites.find((r) => r.siteId === "s1");
    expect([s1?.response.overdue, s1?.longUnresolved]).toEqual([1, 1]);
  });

  it("shows only top concerns when asked, leaving out a quiet Site", () => {
    expect(
      shown({ show: "top" }, s3Contacted()).sites.map((r) => r.siteId),
    ).toEqual(["s1", "s2"]);
  });

  it("doesn't count an Issue still awaiting its first response as a concern", () => {
    // s1's only November Issue was created yesterday and awaits a response.
    const s = edited((t) => {
      for (const c of t.site_contacts) {
        c.publicContact = "available";
        c.siteContact = "available";
      }
    });
    const res = overview(s, {
      interval: november,
      filter: {},
      list: list("sites", { show: "top" }),
      now: NOW,
    });
    expect(res.siteCount).toBe(0);
  });

  // Sites with a perimeter to walk, so no Checks can count against them.
  const walked = (
    /** @type {(t: Record<string, any[]>, m: Record<string, any>) => void} */ more = () => {},
  ) =>
    edited((t, m) => {
      for (const site of t.sites) site.hasPerimeter = true;
      more(t, m);
    });

  /**
   * @param {Snapshot} from
   * @param {typeof november} interval
   */
  const noChecks = (from, interval) =>
    overview(from, { interval, filter: {}, list: list("sites"), now: NOW })
      .sites.filter((r) => r.concerns.includes("fewChecks"))
      .map((r) => r.siteId);

  it("flags an open Site with a perimeter and no Checks in the period", () => {
    // s2 has no November Checks; s3 has none either, but it's closed.
    const flagged = noChecks(walked(), november);
    expect(flagged).toContain("s2");
    expect(flagged).not.toContain("s3");
  });

  /**
   * s1 walked, with these completed Checks on Oct 12 and 13.
   * @param {number} first
   * @param {number} second
   */
  const checksOn = (first, second) =>
    walked((t) => {
      t.site_days.push(
        { siteId: "s1", day: "2026-10-12", completedPerimeterChecks: first },
        { siteId: "s1", day: "2026-10-13", completedPerimeterChecks: second },
      );
    });

  it("flags Few Checks under 3 a day on average, and shows that average", () => {
    const twoDays = days("2026-10-12", "2026-10-14");
    /** @param {Snapshot} from */
    const row = (from) =>
      overview(from, {
        interval: twoDays,
        filter: { siteIds: ["s1"] },
        list: list("sites"),
        now: NOW,
      }).sites[0];
    expect(
      [row(checksOn(3, 3)), row(checksOn(3, 2))].map((r) => [
        r.checksPerDay,
        r.concerns.includes("fewChecks"),
      ]),
    ).toEqual([
      [3, false],
      [2.5, true],
    ]);
  });

  /**
   * s1's Oct 12–13 row, with these Checks and these owed on those days.
   * @param {[number, number]} checks
   * @param {[number, number]} owes 0 for a day it owed nothing
   */
  const owing = ([first, second], owes) =>
    overview(
      walked((t) => {
        t.site_days.push(
          { siteId: "s1", day: "2026-10-12", completedPerimeterChecks: first },
          { siteId: "s1", day: "2026-10-13", completedPerimeterChecks: second },
        );
        const range = ["2026-10-12", "2026-10-13"];
        t.checks_owed = t.checks_owed.filter(
          (r) => r.siteId !== "s1" || !range.includes(r.day),
        );
        range.forEach((day, i) => {
          if (owes[i])
            t.checks_owed.push({ siteId: "s1", day, checksOwed: owes[i] });
        });
      }),
      {
        interval: days("2026-10-12", "2026-10-14"),
        filter: { siteIds: ["s1"] },
        list: list("sites"),
        now: NOW,
      },
    ).sites[0];

  /** @param {Record<string, any>} r */
  const few = (r) => [
    r.checksPerDay,
    r.checksOwedPerDay,
    r.concerns.includes("fewChecks"),
  ];

  it("judges Few Checks against the Site's own number a day, not a flat 3", () => {
    expect([owing([3, 2], [2, 2]), owing([3, 3], [4, 4])].map(few)).toEqual([
      [2.5, 2, false],
      [3, 4, true],
    ]);
  });

  it("averages what the Site owed over its days, as its terms change", () => {
    // Its terms rose from 2 to 4 on Oct 13, so it owed 3 a day on average.
    expect([owing([2, 4], [2, 4]), owing([3, 2], [2, 4])].map(few)).toEqual([
      [3, 3, false],
      [2.5, 3, true],
    ]);
  });

  it("averages over the days the Site owed Checks, so a day it owed nothing doesn't pull it down", () => {
    // It owed nothing on Oct 12, so that day's Checks and its 0 don't count.
    expect(
      [owing([0, 3], [0, 3]), owing([3, 0], [3, 0]), owing([0, 3], [3, 3])].map(
        few,
      ),
    ).toEqual([
      [3, 3, false],
      [3, 3, false],
      [1.5, 3, true],
    ]);
  });

  it("shows the one average the flag compares, so the pages never show two", () => {
    // Its terms began Oct 13: 2 on the one day it owed 3, not 4.0 over both days.
    const r = owing([6, 2], [0, 3]);
    expect([r.checksPerDay, r.checksPerOwedDay, ...few(r).slice(1)]).toEqual([
      2,
      2,
      3,
      true,
    ]);
  });

  it("names no number and flags nothing for a Site that owed no Checks", () => {
    expect([owing([0, 0], [0, 0]), owing([1, 0], [0, 0])].map(few)).toEqual([
      [0, null, false],
      [0.5, null, false],
    ]);
  });

  it("rounds the average before flagging it, so 3.0 a day is never under 3", () => {
    const busy = walked((t) => {
      for (let d = 16; d <= 30; d++)
        t.site_days.push({
          siteId: "s1",
          day: `2026-09-${d}`,
          completedPerimeterChecks: d === 16 ? 45 : 3,
        });
    });
    const res = overview(busy, {
      interval: days("2026-09-16", "2026-10-16"),
      filter: { siteIds: ["s1"] },
      list: list("sites"),
      now: NOW,
    }).sites[0];
    // 45 + 14 × 3 + October's 2 is 89 over 30 days: 2.97, shown as 3.0.
    expect([res.checksPerDay, res.concerns.includes("fewChecks")]).toEqual([
      3,
      false,
    ]);
  });

  it("averages over whole days only, leaving out today, which is still running", () => {
    // s1 has a Check on Nov 3 and one today, Nov 4; only Nov 1–3 are whole.
    const today = walked((t) => {
      const row = t.site_days.find(
        (d) => d.siteId === "s1" && d.day === "2026-11-04",
      );
      row.completedPerimeterChecks = 1;
    });
    const row = overview(today, {
      interval: november,
      filter: { siteIds: ["s1"] },
      list: list("sites"),
      now: NOW,
    }).sites[0];
    expect(row.checksPerDay).toBe(0.3);
  });

  it("averages a Site's Checks over whole days even with no perimeter on file, without flagging it", () => {
    // s1 completed 2 Checks in October's 31 days, s2 and s3 one each.
    const rows = shown({ show: "all" }).sites;
    expect(
      rows.map((r) => [r.checksPerDay, r.concerns.includes("fewChecks")]),
    ).toEqual([
      [0.1, false],
      [0, false],
      [0, false],
    ]);
  });

  it("doesn't flag no Checks without a perimeter, before the data, or before the Site existed", () => {
    const august = parsePeriodParams(
      { period: "month", month: "2026-08" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    const lateSite = walked((t) => {
      t.sites[1].createdAt = "2026-11-20T17:00:00.000Z";
    });
    expect([
      noChecks(snap, november),
      noChecks(walked(), august),
      noChecks(lateSite, november),
      // s1's one Check in three whole days still flags it.
    ]).toEqual([[], [], ["s1"]]);
  });

  it("flags no Checks in a period the records start partway through", () => {
    // Records start on 2026-09-15, a part day; neither Site has a Check after it.
    const september = parsePeriodParams(
      { period: "month", month: "2026-09" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    expect(noChecks(walked(), september)).toEqual(["s1", "s2"]);
  });

  it("doesn't count the records' first day, which is likely a part day", () => {
    const firstDay = parsePeriodParams(
      { period: "custom", from: "2026-09-15", to: "2026-09-16" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    expect(noChecks(walked(), firstDay)).toEqual([]);
  });

  it("waits for the day after a Site is added to end before flagging no Checks", () => {
    // 20:00Z is noon Pacific, a part day; the evaluation day is 2026-11-04.
    const addedOn = (/** @type {string} */ day) =>
      walked((t) => {
        t.sites[1].createdAt = `${day}T20:00:00.000Z`;
      });
    expect([
      noChecks(addedOn("2026-11-03"), november),
      noChecks(addedOn("2026-11-02"), november),
    ]).toEqual([["s1"], ["s1", "s2"]]);
  });

  it("doesn't fail an Overview over a Site whose added time doesn't parse", () => {
    const garbled = walked((t) => {
      t.sites[1].createdAt = "not a time";
    });
    expect(noChecks(garbled, november)).toEqual(["s1", "s2"]);
  });

  it("keeps every row for All Sites, quiet ones too", () => {
    expect(shown({ show: "all" }).sites.map((r) => r.siteId)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("keeps Sites flagged only for few Checks in Top concerns", () => {
    const quiet = walked((t) => {
      for (const c of t.site_contacts) {
        c.publicContact = "available";
        c.siteContact = "available";
      }
    });
    const rows = overview(quiet, {
      interval: november,
      filter: {},
      list: list("sites", { show: "top" }),
      now: NOW,
    }).sites;
    // s1's one Check over 3 whole days is 0.3 a day; s2 has none.
    expect(rows.map((r) => [r.siteId, r.concerns])).toEqual([
      ["s1", ["fewChecks"]],
      ["s2", ["fewChecks"]],
    ]);
  });

  it("doesn't flag no Checks on the first day of a period, before any day has ended", () => {
    const firstDay = walked((_, m) => {
      m.evaluatedAt = "2026-11-01T17:00:00.000Z";
    });
    expect(noChecks(firstDay, november)).toEqual([]);
  });

  it("never counts a missing contact as a top concern", () => {
    const missing = s3Contacted("missing");
    const s3 = shown({}, missing).sites.find((r) => r.siteId === "s3");
    expect([s3?.publicContact.state, s3?.concerns]).toEqual(["missing", []]);
    expect(shown({ show: "top" }, missing).sites.map((r) => r.siteId)).toEqual([
      "s1",
      "s2",
    ]);
    expect(s3?.concerns).not.toContain("noPublicContact");
  });

  it("doesn't list a closed Site's contacts as unknown", () => {
    const closed = edited((t) => {
      const row = t.site_contacts.find((c) => c.siteId === "s3");
      row.publicContact = "unknown";
      row.siteContact = "unknown";
    });
    const s3 = shown({}, closed).sites.find((r) => r.siteId === "s3");
    expect(s3?.unknownEvidence).toEqual([]);
  });

  it("has a row filter for every Overview filter the request accepts", () => {
    expect(Object.keys(SITE_ROW_FILTERS).sort()).toEqual(
      Object.keys(LIST_FILTERS.sites).sort(),
    );
  });

  it("compares periods over the Sites the filters keep, as totals do", () => {
    const filtered = shown({ responseState: "late" });
    const onlyKept = overview(snap, {
      interval: october,
      filter: { siteIds: filtered.sites.map((r) => r.siteId) },
      list: list("sites", {}),
      now: NOW,
    });
    expect(filtered.comparison).toEqual(onlyKept.comparison);
    expect(filtered.comparison).not.toEqual(shown({}).comparison);
  });

  it("lists every Site on one page, past the old 100-row cap", () => {
    const many = edited((t) => {
      for (let i = 4; i <= 150; i++)
        t.sites.push({ ...t.sites[0], siteId: `s${i}`, name: `Site ${i}` });
    });
    const res = overview(many, {
      interval: october,
      filter: {},
      list: list("sites", { limit: "50" }),
      now: NOW,
    });
    expect([res.sites.length, res.siteCount]).toEqual([150, 150]);
    expect(Object.keys(res)).not.toContain("nextCursor");
  });

  it("shows Sites with unknown evidence when asked", () => {
    expect(
      shown({ show: "unknown" }, s3Contacted("unknown")).sites.map(
        (r) => r.siteId,
      ),
    ).toEqual(["s3"]);
  });

  it("filters by one response state and by each contact indicator", () => {
    expect(
      [
        { responseState: "late" },
        { publicContact: "missing" },
        { siteContact: "missing" },
      ].map((params) => shown(params).sites.map((r) => r.siteId)),
    ).toEqual([["s2"], ["s2", "s3"], ["s2", "s3"]]);
  });

  it("filters by several response states at once, as a Site page link sends them", () => {
    expect(
      shown({ responseState: "overdue,late" }).sites.map((r) => r.siteId),
    ).toEqual(["s1", "s2"]);
  });

  it("counts and totals only the Sites the filters keep", () => {
    const res = shown({ responseState: "late" });
    expect([
      res.siteCount,
      res.totals.response.late,
      res.totals.response.overdue,
      res.totals.activity.completedPerimeterChecks,
    ]).toEqual([1, 1, 0, 1]);
  });
});

describe("siteDetail", () => {
  it("returns one row per covered day, ending today in a partial month", () => {
    const res = siteDetail(snap, "s1", { interval: november, now: NOW });
    expect(res.days.map((d) => d.day)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
    expect(res.days[3]).toMatchObject({ unfinishedChecks: 1 });
  });

  it("starts the day rows on the day the Site was added, so earlier days read as no data, not zero", () => {
    const added = edited((t) => {
      t.sites[0].createdAt = "2026-11-02T20:00:00.000Z";
    });
    const res = siteDetail(added, "s1", { interval: november, now: NOW });
    expect(res.days.map((d) => d.day)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
  });

  it("flags the Site for the same reasons as its Overview row", () => {
    const row = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    }).sites.find((r) => r.siteId === "s1");
    const res = siteDetail(snap, "s1", { interval: october, now: NOW });
    expect(res.concerns).toEqual(["repeatedSevere", "slowResponse"]);
    expect(res.concerns).toEqual(row?.concerns);
  });

  it("agrees with its Overview row and the report on every flag and average", () => {
    const walkedSnap = edited((t) => {
      for (const site of t.sites) site.hasPerimeter = true;
      // A day s1 owed nothing, so its owed-days average differs from its whole-days one.
      t.checks_owed = t.checks_owed.filter(
        (r) => r.siteId !== "s1" || r.day !== "2026-10-12",
      );
      // 17 Checks: 17 / 30 owed days rounds to 0.6, 17 / 31 days to 0.5.
      t.site_days.find(
        (d) => d.siteId === "s1" && d.day === "2026-10-02",
      ).completedPerimeterChecks += 15;
    });
    const rows = overview(walkedSnap, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    }).sites;
    const report = reportDataset(walkedSnap, {
      siteIds: rows.map((r) => r.siteId),
      interval: october,
      now: NOW,
    }).sites;
    const pick = (/** @type {Record<string, any>} */ r) => [
      r.concerns,
      r.checksPerDay,
      r.checksOwedPerDay,
      r.checksPerOwedDay,
      r.issuesPer30Days,
      r.longUnresolved,
    ];
    expect(
      rows.map((r) =>
        pick(siteDetail(walkedSnap, r.siteId, { interval: october, now: NOW })),
      ),
    ).toEqual(rows.map(pick));
    expect(report.map(pick)).toEqual(rows.map(pick));
    expect(rows.map((r) => r.checksPerDay)).toEqual([0.6, 0, 0]);
  });

  it("shows the Site's posted public contact, but not its Site manager's", () => {
    const res = siteDetail(snap, "s1", { interval: october, now: NOW });
    expect(res.publicContact).toMatchObject({
      state: "available",
      email: "desk@example.org",
      phone: "415-555-0100",
    });
    expect(
      siteDetail(snap, "s2", { interval: october, now: NOW }).publicContact,
    ).toMatchObject({ state: "missing", email: null, phone: null });
    expect(JSON.stringify(res)).not.toMatch(
      /primaryContact|lead@example\.org|415-555-0101|Synthetic Lead/,
    );
  });

  it("counts the period's Issues by severity band, to match the Issue list", () => {
    const res = siteDetail(snap, "s1", { interval: october, now: NOW });
    const bands = LIST_FILTERS.issues.severityBand;
    const listed = bands.map(
      (severityBand) =>
        listIssues(snap, {
          interval: october,
          filter: { siteIds: ["s1"] },
          list: list("issues", { severityBand }),
          now: NOW,
        }).total,
    );
    expect(bands.map((band) => res.totals.severity[band])).toEqual(listed);
    expect(res.totals.severity.severe).toBe(res.totals.activity.severeIssues);
    expect(listed.reduce((a, b) => a + b, 0)).toBe(
      res.totals.activity.issuesCreated,
    );
  });

  it("answers 404 for a Site the snapshot doesn't have", () => {
    expect(() =>
      siteDetail(snap, "nope", { interval: october, now: NOW }),
    ).toThrow(expect.objectContaining({ statusCode: 404 }));
  });
});

describe("listIssues", () => {
  it("lists Issues created in the period, newest first", () => {
    const res = listIssues(snap, {
      interval: october,
      filter: {},
      list: list("issues"),
      now: NOW,
    });
    expect(res.issues.map((i) => i.issueId)).toEqual(["t3", "t2", "t5", "t1"]);
    expect(res.total).toBe(4);
  });

  it("filters by severity band and by resolved", () => {
    const severe = listIssues(snap, {
      interval: october,
      filter: {},
      list: list("issues", { severityBand: "severe" }),
      now: NOW,
    });
    const resolved = listIssues(snap, {
      interval: october,
      filter: {},
      list: list("issues", { issueStatus: "resolved" }),
      now: NOW,
    });
    expect(severe.issues.map((i) => i.issueId)).toEqual(["t3", "t1"]);
    expect(resolved.issues.map((i) => i.issueId)).toEqual(["t3"]);
  });

  it("lists every severity band in a comma list, as the Site page asks", () => {
    /** @param {string} severityBand */
    const ids = (severityBand) =>
      listIssues(snap, {
        interval: october,
        filter: {},
        list: list("issues", { severityBand }),
        now: NOW,
      }).issues.map((i) => i.issueId);
    const both = ids("minor,severe");
    expect(both.length).toBeGreaterThan(ids("severe").length);
    expect([...both].sort()).toEqual(
      [...ids("minor"), ...ids("severe")].sort(),
    );
  });

  it("lists every response state in a comma list, as the Site page asks", () => {
    /**
     * @param {string} responseState
     * @returns {string[]}
     */
    const ids = (responseState) =>
      listIssues(snap, {
        interval: october,
        filter: {},
        list: list("issues", { responseState }),
        now: NOW,
      }).issues.map((i) => i.issueId);
    expect([ids("overdue"), ids("late"), ids("overdue,late")]).toEqual([
      ["t2"],
      ["t5"],
      ["t2", "t5"],
    ]);
  });

  it("lists the Issues behind each concern flag, as many as the flag counted", () => {
    /** @param {string} concern @param {string} siteId */
    const ids = (concern, siteId) =>
      listIssues(snap, {
        interval: october,
        filter: { siteIds: [siteId] },
        list: list("issues", { concern }),
        now: NOW,
      })
        .issues.map((i) => i.issueId)
        .sort();
    // t1 is open since Oct 2, t2 Overdue, t5 late; t1 and t3 are Severe.
    expect([
      ids("slowResponse", "s1"),
      ids("slowResponse", "s2"),
      ids("repeatedSevere", "s1"),
    ]).toEqual([["t1", "t2"], ["t5"], ["t1", "t3"]]);
    const rows = overview(snap, {
      interval: october,
      filter: {},
      list: list("sites"),
      now: NOW,
    }).sites;
    expect(
      rows.map(
        (r) =>
          r.response.overdue + r.response.late + r.longUnresolved ===
          ids("slowResponse", r.siteId).length,
      ),
    ).toEqual([true, true, true]);
  });

  it("pages through every Issue once with a cursor", () => {
    const first = listIssues(snap, {
      interval: october,
      filter: {},
      list: list("issues", { limit: "2" }),
      now: NOW,
    });
    const second = listIssues(snap, {
      interval: october,
      filter: {},
      list: list("issues", { limit: "2", cursor: first.nextCursor }),
      now: NOW,
    });
    expect([...first.issues, ...second.issues].map((i) => i.issueId)).toEqual([
      "t3",
      "t2",
      "t5",
      "t1",
    ]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("issueDetail and checkDetail", () => {
  it("returns an Issue with its parent Check and Site name", () => {
    const res = issueDetail(snap, "t1", { now: NOW });
    expect(res.issue.responseState).toBe("onTime");
    expect(res.check?.checkId).toBe("c1");
    expect(res.site).toEqual({
      siteId: "s1",
      name: "Synthetic Site 1",
      manageHref: "/sites/s1",
    });
  });

  it("returns a Check with the Issues raised from it", () => {
    const res = checkDetail(snap, "c1", { now: NOW });
    expect(res.issues.map((i) => i.issueId)).toEqual(["t1"]);
  });

  it("answers 404 for an unknown Issue", () => {
    expect(() => issueDetail(snap, "nope", { now: NOW })).toThrow(
      expect.objectContaining({ code: "issue_not_found", statusCode: 404 }),
    );
  });

  it("asks for the Site when two Sites share an Issue ID, then finds it", () => {
    const s = edited((t) => {
      t.issues.push({
        ...t.issues.find((i) => i.siteId === "s2"),
        issueId: "t1",
      });
    });
    expect(() => issueDetail(s, "t1", { now: NOW })).toThrow(
      expect.objectContaining({ code: "site_id_required" }),
    );
    expect(issueDetail(s, "t1", { siteId: "s2", now: NOW }).issue.siteId).toBe(
      "s2",
    );
  });
});

describe("listChecks", () => {
  it("dates completed Checks by completion and unfinished ones by start", () => {
    const res = listChecks(snap, {
      interval: november,
      filter: {},
      list: list("checks"),
      now: NOW,
    });
    expect(res.checks.map((c) => [c.checkId, c.state])).toEqual([
      ["c5", "unfinished"],
      ["c4", "completed"],
    ]);
  });

  it("filters to single-issue reports", () => {
    const res = listChecks(snap, {
      interval: october,
      filter: {},
      list: list("checks", { source: "single-problem" }),
      now: NOW,
    });
    expect(res.checks.map((c) => c.checkId)).toEqual(["c3"]);
  });
});

describe("scopeOptions", () => {
  it("counts Sites in each group value, without a list of Sites", () => {
    const res = scopeOptions(snap, { now: NOW });
    expect(res.groups.department).toEqual([
      { value: "Example Department", sites: 2 },
      { value: "Other Department", sites: 1 },
    ]);
    expect(Object.keys(res)).not.toContain("sites");
  });

  it("lists only each Site's ID and name when a screen asks for them", () => {
    const res = scopeOptions(snap, { now: NOW, include: "sites" });
    expect(res.sites?.[0]).toEqual({
      siteId: "s1",
      name: "Synthetic Site 1",
    });
    expect(res.sites).toHaveLength(3);
  });

  it("lists each Issue category in the data once, in order", () => {
    const s = edited((t) => {
      t.issues[0].category = null;
    });
    expect(scopeOptions(s, { now: NOW }).categories).toEqual([
      "Debris",
      "Unsecured gate",
    ]);
  });
});

describe("trends", () => {
  it("splits a month into weeks from its first day, current and prior", () => {
    const res = trends(snap, {
      interval: october,
      scope: { siteIds: ["s1"] },
      breakdown: "department",
      now: NOW,
    });
    expect(res.series.granularity).toBe("week");
    expect(res.series.current.map((b) => b.start)).toEqual([
      "2026-10-01",
      "2026-10-08",
      "2026-10-15",
      "2026-10-22",
      "2026-10-29",
    ]);
    expect(res.series.current[0].completedPerimeterChecks).toBe(1);
    expect(res.series.prior[0].start).toBe("2026-09-01");
  });

  it("flags a week that starts before the first record", () => {
    const res = trends(snap, {
      interval: parsePeriodParams(
        { period: "custom", from: "2026-09-10", to: "2026-10-10" },
        TEST_EVALUATED_AT,
      ),
      scope: {},
      now: NOW,
    });
    expect(
      res.series.current
        .slice(0, 2)
        .map((b) => [b.start, b.noData, b.partialCoverage]),
    ).toEqual([
      ["2026-09-10", false, true],
      ["2026-09-17", false, false],
    ]);
  });

  it("uses months for a year and marks the month still running as partial", () => {
    const year = parsePeriodParams(
      { period: "year", year: "2026" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    const res = trends(snap, { interval: year, scope: {}, now: NOW });
    expect(res.series.granularity).toBe("month");
    expect(res.series.current.at(-1)).toMatchObject({
      start: "2026-11-01",
      partial: true,
    });
    expect(res.series.current[0]).toMatchObject({ noData: true });
  });

  it("uses weeks for a long custom period, so current and prior pair up", () => {
    const custom = parsePeriodParams(
      { period: "custom", from: "2026-01-31", to: "2026-05-11" },
      TEST_EVALUATED_AT,
      snap.dataDays,
    );
    const res = trends(snap, { interval: custom, scope: {}, now: NOW });
    expect(res.series.granularity).toBe("week");
    expect(res.series.prior).toHaveLength(res.series.current.length);
    expect(res.series.current[0]).toMatchObject({
      start: "2026-01-31",
      end: "2026-02-07",
    });
  });

  it("combines picked Sites with Sites matching every chosen group", () => {
    const res = trends(snap, {
      interval: october,
      scope: { siteIds: ["s3"], groups: { department: ["Other Department"] } },
      now: NOW,
    });
    expect(res.scope.siteIds).toEqual(["s2", "s3"]);
  });

  it("needs a Site to match every group, not just one", () => {
    const res = trends(snap, {
      interval: october,
      scope: {
        groups: { department: ["Other Department"], siteType: ["shelter"] },
      },
      now: NOW,
    });
    expect(res.scope.siteIds).toEqual([]);
  });

  it("compares each group over the same days as the top comparison", () => {
    const res = trends(snap, {
      interval: november,
      scope: { siteIds: ["s1", "s2"] },
      breakdown: "providerId",
      now: NOW,
    });
    const alone = trends(snap, {
      interval: november,
      scope: { siteIds: ["s1"] },
      now: NOW,
    });
    const g = res.breakdown?.find((b) => b.value === "v1");
    // c5 is today's unfinished Check; the like-for-like days leave today out.
    const change = /** @type {any} */ (alone.comparison.change)
      .unfinishedChecks;
    expect([g?.current.unfinishedChecks, g?.prior?.unfinishedChecks]).toEqual([
      change.current,
      change.prior,
    ]);
  });

  it("counts Issues by category for the scope", () => {
    const res = trends(snap, {
      interval: october,
      scope: { siteIds: ["s1"] },
      now: NOW,
    });
    expect(res.categories).toEqual([
      { category: "Unsecured gate", issues: 2, severeIssues: 2 },
      { category: "Debris", issues: 1, severeIssues: 0 },
    ]);
  });

  it("breaks totals down by group, current and prior", () => {
    const res = trends(snap, {
      interval: october,
      scope: {},
      breakdown: "department",
      now: NOW,
    });
    expect(
      res.breakdown?.map((g) => [g.value, g.sites, g.current.issuesCreated]),
    ).toEqual([
      ["Example Department", 2, 3],
      ["Other Department", 1, 1],
    ]);
  });
});

describe("exportRows", () => {
  it.each(["issues", "checks", "sites"])(
    "counts %s the same as the rows it builds",
    (dataset) => {
      const req = {
        dataset: /** @type {any} */ (dataset),
        interval: october,
        filter: { status: "active" },
        list: list(/** @type {any} */ (dataset)),
      };
      expect(exportRowCount(snap, req)).toBe(exportRows(snap, req).rows.length);
    },
  );

  it("counts October's rows for active Sites", () => {
    const req = (/** @type {any} */ dataset) => ({
      dataset,
      interval: october,
      filter: { status: "active" },
      list: list(dataset),
    });
    expect(
      ["issues", "checks", "sites"].map((d) => exportRowCount(snap, req(d))),
    ).toEqual([4, 4, 2]);
  });

  it.each(Object.keys(SORTS.sites))(
    "writes Sites in the order Overview shows them, sorted by %s",
    (sort) => {
      /** @param {string} dir */
      const args = (dir) => ({
        interval: october,
        filter: {},
        list: list("sites", { sort, dir }),
      });
      const ids = (/** @type {Record<string, any>[]} */ rows) =>
        rows.map((r) => r.siteId);
      // An export that skipped sorting would write table order, so test a direction that differs.
      const tableOrder = ids(snap.tables.sites);
      const dir = ["asc", "desc"].find(
        (d) =>
          ids(overview(snap, { ...args(d), now: NOW }).sites).join() !==
          tableOrder.join(),
      );
      expect(dir).toBeDefined();
      const shown = overview(snap, { ...args(String(dir)), now: NOW }).sites;
      const written = exportRows(snap, {
        dataset: "sites",
        ...args(String(dir)),
      }).rows;
      expect(ids(written)).toEqual(ids(shown));
    },
  );

  it("returns every matching row, not one page", () => {
    const res = exportRows(snap, {
      dataset: "issues",
      interval: october,
      filter: {},
      list: list("issues", { limit: "1" }),
    });
    expect(res.rows).toHaveLength(4);
    expect(res.columns).toContain("responseState");
  });

  it.each([
    { responseState: "late" },
    { show: "top" },
    { siteContact: "missing" },
  ])("writes the same Sites to the CSV as Overview shows for %j", (params) => {
    const args = { interval: october, filter: {}, list: list("sites", params) };
    const shown = overview(snap, { ...args, now: NOW }).sites.map(
      (r) => r.siteId,
    );
    const req = { dataset: /** @type {const} */ ("sites"), ...args };
    expect([
      exportRowCount(snap, req),
      exportRows(snap, req).rows.map((r) => r.siteId),
    ]).toEqual([shown.length, shown]);
  });

  it("flattens Overview rows for the Sites CSV", () => {
    const res = exportRows(snap, {
      dataset: "sites",
      interval: october,
      filter: {},
      list: list("sites"),
    });
    expect(res.rows[0]).toMatchObject({
      siteId: "s1",
      overdue: 1,
      publicContact: "available",
      publicEmail: "desk@example.org",
      publicPhone: "415-555-0100",
    });
    // Each posted part in its own column, right after the contact state.
    const at = res.columns.indexOf("publicContact");
    expect(res.columns.slice(at, at + 4)).toEqual([
      "publicContact",
      "publicEmail",
      "publicPhone",
      "publicPhoneExtension",
    ]);
    expect(res.rows.find((r) => r.siteId === "s2")).toMatchObject({
      publicContact: "missing",
      publicEmail: null,
      publicPhone: null,
    });
  });
});

describe("reportDataset", () => {
  it("lists every Severe Issue created in the period for each Site", () => {
    const res = reportDataset(snap, {
      siteIds: ["s1"],
      interval: october,
      now: NOW,
    });
    expect(res.sites[0].severeIssues.map((i) => i.issueId)).toEqual([
      "t1",
      "t3",
    ]);
    expect(res.sites[0].totals.response.overdue).toBe(1);
  });

  it("gives each Site its current public contact, or the No public contact flag", () => {
    const res = reportDataset(snap, {
      siteIds: ["s1", "s2", "s3"],
      interval: october,
      now: NOW,
    });
    expect(
      res.sites.map((s) => [
        s.site.siteId,
        s.publicContact.state,
        s.publicContact.email,
        s.publicContact.phone,
        s.noPublicContact,
      ]),
    ).toEqual([
      ["s1", "available", "desk@example.org", "415-555-0100", false],
      ["s2", "missing", null, null, true],
      // Closed, so its missing contact isn't flagged, as on Overview.
      ["s3", "missing", null, null, false],
    ]);
    expect(JSON.stringify(res)).not.toMatch(
      /primaryContact|lead@example\.org|415-555-0101|Synthetic Lead/,
    );
  });

  it("leaves out Severe Issues from outside the period", () => {
    const res = reportDataset(snap, {
      siteIds: ["s1"],
      interval: november,
      now: NOW,
    });
    expect(res.sites[0].severeIssues).toEqual([]);
  });
});
