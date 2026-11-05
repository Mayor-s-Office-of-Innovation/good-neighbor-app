import { describe, expect, it } from "vitest";
import { SORTS, parseListQuery, parsePeriodParams } from "./requests.js";
import {
  checkDetail,
  dataQuality,
  exportRowCount,
  exportRows,
  issueDetail,
  listChecks,
  listIssues,
  overview,
  reportDataset,
  scopeOptions,
  siteDetail,
  trends,
} from "./read-model.js";
import { indexSnapshot } from "./snapshot.js";
import { TEST_EVALUATED_AT, syntheticProjection } from "./test-projection.js";

const NOW = Date.parse("2026-11-04T20:00:00.000Z");
const { manifest, tables } = syntheticProjection();
const snap = indexSnapshot({ prefix: "p1", manifest, tables });
const october = parsePeriodParams(
  { period: "month", month: "2026-10" },
  TEST_EVALUATED_AT,
);
const november = parsePeriodParams({}, TEST_EVALUATED_AT);

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
    );
    expect(dataQuality(snap, august, NOW)).toMatchObject({
      state: "partial",
      reasons: ["before_coverage"],
      coverageStart: "2026-09-15",
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

  it.each(["asc"])(
    "puts a Site with no Issues last, even sorted %s, lowest first",
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
    expect(res.comparison.basis).toBe("complete_period");
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
    expect(res.comparison).toMatchObject({
      basis: "elapsed_complete_days",
      days: 3,
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
      siteContact: { state: "missing" },
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
    expect(res.sites.map((s) => s.siteId)).toEqual(["s3", "s1", "s2"]);
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
  it("counts Sites in each group value", () => {
    const res = scopeOptions(snap, { now: NOW });
    expect(res.groups.department).toEqual([
      { value: "Example Department", sites: 2 },
      { value: "Other Department", sites: 1 },
    ]);
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

  it("uses months for a year and marks the month still running as partial", () => {
    const year = parsePeriodParams(
      { period: "year", year: "2026" },
      TEST_EVALUATED_AT,
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
      // Against each key's default, since the defaults all give name order.
      const dir = SORTS.sites[/** @type {keyof typeof SORTS.sites} */ (sort)];
      const args = {
        interval: october,
        filter: {},
        list: list("sites", { sort, dir: dir === "asc" ? "desc" : "asc" }),
      };
      const shown = overview(snap, { ...args, now: NOW }).sites;
      const written = exportRows(snap, { dataset: "sites", ...args }).rows;
      expect(written.map((r) => r.siteId)).toEqual(shown.map((r) => r.siteId));
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

  it("leaves out Severe Issues from outside the period", () => {
    const res = reportDataset(snap, {
      siteIds: ["s1"],
      interval: november,
      now: NOW,
    });
    expect(res.sites[0].severeIssues).toEqual([]);
  });
});
