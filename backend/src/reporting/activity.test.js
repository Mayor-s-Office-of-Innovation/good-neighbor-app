import { describe, expect, it } from "vitest";
import {
  SITE_DAY_METRICS,
  buildCheckFacts,
  compareTotals,
  sumSiteDays,
} from "./activity.js";

const EVALUATED = "2026-11-04T20:00:00.000Z";

/**
 * @param {Partial<import("./activity.js").CheckRow>} overrides
 * @returns {import("./activity.js").CheckRow}
 */
function check(overrides) {
  return {
    siteId: "s1",
    checkId: "c1",
    status: "completed",
    flowType: "perimeter",
    startedAt: "2026-11-02T17:00:00.000Z",
    completedAt: "2026-11-02T17:10:00.000Z",
    ...overrides,
  };
}

/**
 * @param {Record<string, any>} overrides
 * @returns {{ siteId: string, checkId?: string | null }}
 */
function issue(overrides) {
  return /** @type {any} */ ({
    issueId: "t1",
    siteId: "s1",
    createdDay: "2026-11-02",
    severityBand: "minor",
    responseState: "onTime",
    ...overrides,
  });
}

describe("sumSiteDays and compareTotals", () => {
  /**
   * @param {string} siteId
   * @param {string} day
   */
  const day = (siteId, day) => ({
    siteId,
    day,
    ...Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0])),
    completedPerimeterChecks: 1,
  });
  const rows = [
    day("s1", "2026-10-02"),
    day("s1", "2026-11-02"),
    day("s2", "2026-11-02"),
  ];

  it("leaves out the end day", () => {
    const { total, bySite } = sumSiteDays(rows, {
      startDay: "2026-11-01",
      endDay: "2026-11-02",
    });
    expect(total.completedPerimeterChecks).toBe(0);
    expect(bySite.size).toBe(0);
  });

  it("includes the start day, per Site and overall", () => {
    const { total, bySite } = sumSiteDays(rows, {
      startDay: "2026-11-02",
      endDay: "2026-11-03",
    });
    expect(total.completedPerimeterChecks).toBe(2);
    expect(
      [...bySite].map(([site, t]) => [site, t.completedPerimeterChecks]),
    ).toEqual([
      ["s1", 1],
      ["s2", 1],
    ]);
  });

  it("limits totals to the chosen Sites", () => {
    const { total } = sumSiteDays(
      rows,
      { startDay: "2026-10-01", endDay: "2026-12-01" },
      new Set(["s2"]),
    );
    expect(total.completedPerimeterChecks).toBe(1);
  });

  it("reports a drop as a negative change", () => {
    const november = sumSiteDays(rows, {
      startDay: "2026-11-01",
      endDay: "2026-12-01",
    }).total;
    const october = sumSiteDays(rows, {
      startDay: "2026-10-01",
      endDay: "2026-11-01",
    }).total;
    expect(compareTotals(october, november).completedPerimeterChecks).toEqual({
      current: 1,
      prior: 2,
      change: -1,
    });
  });

  it("reports the change in counts, including from zero", () => {
    const current = sumSiteDays(rows, {
      startDay: "2026-11-01",
      endDay: "2026-12-01",
    }).total;
    const prior = sumSiteDays(rows, {
      startDay: "2026-09-01",
      endDay: "2026-10-01",
    }).total;
    expect(compareTotals(current, prior).completedPerimeterChecks).toEqual({
      current: 2,
      prior: 0,
      change: 2,
    });
  });
});

describe("buildCheckFacts", () => {
  it("writes the start time in the same form as the others", () => {
    const { checks } = buildCheckFacts(
      {
        checks: [check({ startedAt: "2026-11-02T10:00:00-07:00" })],
        issues: [],
      },
      EVALUATED,
    );
    expect(checks[0].startedAt).toBe("2026-11-02T17:00:00.000Z");
  });

  it("gives no start time rather than an empty one", () => {
    const { checks } = buildCheckFacts(
      { checks: [check({ startedAt: "" })], issues: [] },
      EVALUATED,
    );
    expect(checks[0].startedAt).toBeNull();
  });

  it("counts a Check finished after the snapshot as unfinished", () => {
    const { checks } = buildCheckFacts(
      {
        checks: [check({ completedAt: "2026-11-04T21:00:00.000Z" })],
        issues: [],
      },
      EVALUATED,
    );
    expect([checks[0].state, checks[0].completedAt]).toEqual([
      "unfinished",
      null,
    ]);
  });

  it("uses the synthesis time when an older Check has no completion time", () => {
    const { checks } = buildCheckFacts(
      {
        checks: [
          check({
            completedAt: null,
            synthesizedAt: "2026-11-02T17:20:00.000Z",
          }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(checks[0].completedAt).toBe("2026-11-02T17:20:00.000Z");
  });

  it("dates a completed Check by completion and an unfinished one by start", () => {
    const { checks } = buildCheckFacts(
      {
        checks: [
          check({ checkId: "c1" }),
          check({
            checkId: "c2",
            status: "in_progress",
            startedAt: "2026-11-03T08:00:00.000Z",
            completedAt: null,
          }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(
      checks.map((c) => [c.checkId, c.state, c.activityAt, c.day]),
    ).toEqual([
      ["c1", "completed", "2026-11-02T17:10:00.000Z", "2026-11-02"],
      ["c2", "unfinished", "2026-11-03T08:00:00.000Z", "2026-11-03"],
    ]);
  });

  it("gives no completion time to a completed Check that never recorded one", () => {
    const { checks } = buildCheckFacts(
      { checks: [check({ completedAt: null })], issues: [] },
      EVALUATED,
    );
    expect([checks[0].state, checks[0].completedAt]).toEqual([
      "completed",
      null,
    ]);
  });

  it("marks single-issue reports apart from perimeter Checks", () => {
    const { checks } = buildCheckFacts(
      {
        checks: [check({ flowType: "single-problem" })],
        issues: [],
      },
      EVALUATED,
    );
    expect(checks[0].source).toBe("single-problem");
  });

  it("counts each Check's canonical Issues", () => {
    const { checks } = buildCheckFacts(
      {
        checks: [check({ checkId: "c1" }), check({ checkId: "c2" })],
        issues: [
          issue({ issueId: "t1", checkId: "c1" }),
          issue({ issueId: "t2", checkId: "c1" }),
          issue({ issueId: "t3", siteId: "s2", checkId: "c2" }),
        ],
      },
      EVALUATED,
    );
    expect(checks.map((c) => [c.checkId, c.issues])).toEqual([
      ["c1", 2],
      ["c2", 0],
    ]);
  });

  it("leaves out undated Checks and Checks started after the snapshot", () => {
    const { checks, undatedChecks } = buildCheckFacts(
      {
        checks: [
          check({ checkId: "c1" }),
          check({ checkId: "c2", startedAt: null, completedAt: null }),
          check({
            checkId: "c3",
            status: "in_progress",
            startedAt: "2026-11-05T08:00:00.000Z",
            completedAt: null,
          }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(checks.map((c) => c.checkId)).toEqual(["c1"]);
    expect(undatedChecks).toBe(1);
  });
});
