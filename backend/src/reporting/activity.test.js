import { describe, expect, it } from "vitest";
import { buildSiteDays, compareTotals, sumSiteDays } from "./activity.js";
import { assertNoJudgementFields } from "./contract.js";

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
 * @param {Partial<import("./issue-facts.js").IssueFact>} overrides
 * @returns {import("./issue-facts.js").IssueFact}
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

describe("buildSiteDays", () => {
  it("counts completed perimeter Checks, single-issue reports and unfinished Checks apart", () => {
    const { siteDays } = buildSiteDays(
      {
        checks: [
          check({ checkId: "c1" }),
          check({ checkId: "c2", flowType: "single-problem" }),
          check({ checkId: "c3", status: "in_progress", completedAt: null }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(siteDays).toEqual([
      expect.objectContaining({
        day: "2026-11-02",
        completedPerimeterChecks: 1,
        singleIssueReports: 1,
        unfinishedChecks: 1,
      }),
    ]);
  });

  it("puts a Check finished at 11:30 pm Pacific on that local day, not the UTC one", () => {
    const { siteDays } = buildSiteDays(
      {
        checks: [check({ completedAt: "2026-11-03T07:30:00.000Z" })],
        issues: [],
      },
      EVALUATED,
    );
    expect(siteDays.map((r) => r.day)).toEqual(["2026-11-02"]);
  });

  it("splits the 25-hour fall-back day at Pacific midnights", () => {
    const { siteDays } = buildSiteDays(
      {
        checks: [
          check({ checkId: "a", completedAt: "2026-11-01T07:00:00.000Z" }),
          check({ checkId: "b", completedAt: "2026-11-02T07:59:59.000Z" }),
          check({ checkId: "c", completedAt: "2026-11-02T08:00:00.000Z" }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(siteDays.map((r) => [r.day, r.completedPerimeterChecks])).toEqual([
      ["2026-11-01", 2],
      ["2026-11-02", 1],
    ]);
  });

  it("counts a Check finished after the snapshot as unfinished on its start day", () => {
    const { siteDays } = buildSiteDays(
      {
        checks: [check({ completedAt: "2026-11-05T00:00:00.000Z" })],
        issues: [],
      },
      EVALUATED,
    );
    expect(siteDays).toMatchObject([
      { day: "2026-11-02", unfinishedChecks: 1, completedPerimeterChecks: 0 },
    ]);
  });

  it("leaves out a Check started after the snapshot", () => {
    const result = buildSiteDays(
      {
        checks: [
          check({
            status: "in_progress",
            startedAt: "2026-11-05T00:00:00.000Z",
            completedAt: null,
          }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(result).toEqual({ siteDays: [], undatedChecks: 0 });
  });

  it("counts a Check with no usable time as undated", () => {
    const result = buildSiteDays(
      {
        checks: [
          check({ startedAt: null, completedAt: null, synthesizedAt: null }),
        ],
        issues: [],
      },
      EVALUATED,
    );
    expect(result).toEqual({ siteDays: [], undatedChecks: 1 });
  });

  it("counts a completed Check with only a start time on its start day", () => {
    const { siteDays } = buildSiteDays(
      {
        checks: [check({ completedAt: null, synthesizedAt: null })],
        issues: [],
      },
      EVALUATED,
    );
    expect(siteDays).toMatchObject([
      { day: "2026-11-02", completedPerimeterChecks: 1 },
    ]);
  });

  it.each([[""], ["garbage"]])(
    "falls back to the synthesis time when completedAt is %j",
    (completedAt) => {
      const { siteDays } = buildSiteDays(
        {
          checks: [
            check({ completedAt, synthesizedAt: "2026-11-03T18:00:00.000Z" }),
          ],
          issues: [],
        },
        EVALUATED,
      );
      expect(siteDays).toMatchObject([
        { day: "2026-11-03", completedPerimeterChecks: 1 },
      ]);
    },
  );

  it("counts a completed Check with no flow type as a perimeter Check", () => {
    const { siteDays } = buildSiteDays(
      { checks: [check({ flowType: null })], issues: [] },
      EVALUATED,
    );
    expect(siteDays).toMatchObject([{ completedPerimeterChecks: 1 }]);
  });

  it("adds Issues by creation day with their severity and response state", () => {
    const { siteDays } = buildSiteDays(
      {
        checks: [],
        issues: [
          issue({ severityBand: "severe", responseState: "overdue" }),
          issue({ issueId: "t2", responseState: "late" }),
        ],
      },
      EVALUATED,
    );
    expect(siteDays[0]).toMatchObject({
      issuesCreated: 2,
      severeIssues: 1,
      overdue: 1,
      late: 1,
      onTime: 0,
    });
  });

  it("has no expected-check or score column", () => {
    const { siteDays } = buildSiteDays(
      { checks: [check({})], issues: [] },
      EVALUATED,
    );
    expect(() =>
      assertNoJudgementFields(Object.keys(siteDays[0])),
    ).not.toThrow();
  });
});

describe("sumSiteDays and compareTotals", () => {
  const rows = buildSiteDays(
    {
      checks: [
        check({ checkId: "a", completedAt: "2026-10-02T17:00:00.000Z" }),
        check({ checkId: "b", completedAt: "2026-11-02T17:00:00.000Z" }),
        check({
          checkId: "c",
          siteId: "s2",
          completedAt: "2026-11-02T17:00:00.000Z",
        }),
      ],
      issues: [],
    },
    EVALUATED,
  ).siteDays;

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
