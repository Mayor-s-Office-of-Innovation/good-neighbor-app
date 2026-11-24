import { describe, expect, it } from "vitest";
import { assertNoJudgementFields } from "./contract.js";
import { buildFromRows } from "./test-build.js";

const EVALUATED = "2026-11-04T20:00:00.000Z";

/**
 * @param {Record<string, any>} overrides
 * @returns {Record<string, any>}
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
 * @returns {Record<string, any>}
 */
function task(overrides) {
  return {
    siteId: "s1",
    taskId: "t1",
    status: "open",
    createdAt: "2026-11-02T17:10:00.000Z",
    severity: 2,
    checkId: "c1",
    ...overrides,
  };
}

/**
 * @param {import("./projection.js").ProjectionInputs} rows
 * @param {string} evaluatedAt
 */
async function buildSiteDays(rows, evaluatedAt) {
  const { tables, manifest } = await buildFromRows(rows, evaluatedAt);
  return {
    siteDays: tables.site_days,
    undatedChecks: manifest.dataQuality.undatedChecks,
  };
}

describe("site_days in the projection", () => {
  it("counts completed perimeter Checks, single-issue reports and unfinished Checks apart", async () => {
    const { siteDays } = await buildSiteDays(
      {
        checks: [
          check({ checkId: "c1" }),
          check({ checkId: "c2", flowType: "single-problem" }),
          check({ checkId: "c3", status: "in_progress", completedAt: null }),
        ],
        tasks: [],
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

  it("puts a Check finished at 11:30 pm Pacific on that local day, not the UTC one", async () => {
    const { siteDays } = await buildSiteDays(
      {
        checks: [check({ completedAt: "2026-11-03T07:30:00.000Z" })],
        tasks: [],
      },
      EVALUATED,
    );
    expect(siteDays.map((r) => r.day)).toEqual(["2026-11-02"]);
  });

  it("splits the 25-hour fall-back day at Pacific midnights", async () => {
    const { siteDays } = await buildSiteDays(
      {
        checks: [
          check({ checkId: "a", completedAt: "2026-11-01T07:00:00.000Z" }),
          check({ checkId: "b", completedAt: "2026-11-02T07:59:59.000Z" }),
          check({ checkId: "c", completedAt: "2026-11-02T08:00:00.000Z" }),
        ],
        tasks: [],
      },
      EVALUATED,
    );
    expect(siteDays.map((r) => [r.day, r.completedPerimeterChecks])).toEqual([
      ["2026-11-01", 2],
      ["2026-11-02", 1],
    ]);
  });

  it("counts a Check finished after the snapshot as unfinished on its start day", async () => {
    const { siteDays } = await buildSiteDays(
      {
        checks: [check({ completedAt: "2026-11-05T00:00:00.000Z" })],
        tasks: [],
      },
      EVALUATED,
    );
    expect(siteDays).toMatchObject([
      { day: "2026-11-02", unfinishedChecks: 1, completedPerimeterChecks: 0 },
    ]);
  });

  it("leaves out a Check started after the snapshot", async () => {
    const result = await buildSiteDays(
      {
        checks: [
          check({
            status: "in_progress",
            startedAt: "2026-11-05T00:00:00.000Z",
            completedAt: null,
          }),
        ],
        tasks: [],
      },
      EVALUATED,
    );
    expect(result).toEqual({ siteDays: [], undatedChecks: 0 });
  });

  it("counts a Check with no usable time as undated", async () => {
    const result = await buildSiteDays(
      {
        checks: [
          check({ startedAt: null, completedAt: null, synthesizedAt: null }),
        ],
        tasks: [],
      },
      EVALUATED,
    );
    expect(result).toEqual({ siteDays: [], undatedChecks: 1 });
  });

  it("counts a completed Check with only a start time on its start day", async () => {
    const { siteDays } = await buildSiteDays(
      {
        checks: [check({ completedAt: null, synthesizedAt: null })],
        tasks: [],
      },
      EVALUATED,
    );
    expect(siteDays).toMatchObject([
      { day: "2026-11-02", completedPerimeterChecks: 1 },
    ]);
  });

  it.each([[""], ["garbage"]])(
    "falls back to the synthesis time when completedAt is %j",
    async (completedAt) => {
      const { siteDays } = await buildSiteDays(
        {
          checks: [
            check({ completedAt, synthesizedAt: "2026-11-03T18:00:00.000Z" }),
          ],
          tasks: [],
        },
        EVALUATED,
      );
      expect(siteDays).toMatchObject([
        { day: "2026-11-03", completedPerimeterChecks: 1 },
      ]);
    },
  );

  it("counts a completed Check with no flow type as a perimeter Check", async () => {
    const { siteDays } = await buildSiteDays(
      { checks: [check({ flowType: null })], tasks: [] },
      EVALUATED,
    );
    expect(siteDays).toMatchObject([{ completedPerimeterChecks: 1 }]);
  });

  it("adds Issues by creation day with their severity and response state", async () => {
    const { siteDays } = await buildSiteDays(
      {
        checks: [],
        // Both pass their 72-hour deadline; staff answer t2 late.
        tasks: [
          task({ severity: 4, createdAt: "2026-10-30T17:10:00.000Z" }),
          task({ taskId: "t2", createdAt: "2026-10-30T17:10:00.000Z" }),
        ],
        updates: [
          {
            siteId: "s1",
            taskId: "t2",
            type: "escalation_action_taken",
            occurredAt: "2026-11-03T00:00:00.000Z",
          },
        ],
      },
      EVALUATED,
    );
    expect(siteDays[0]).toMatchObject({
      day: "2026-10-30",
      issuesCreated: 2,
      severeIssues: 1,
      overdue: 1,
      late: 1,
      onTime: 0,
    });
  });

  it("has no expected-check or score column", async () => {
    const { siteDays } = await buildSiteDays(
      { checks: [check({})], tasks: [] },
      EVALUATED,
    );
    expect(() =>
      assertNoJudgementFields(Object.keys(siteDays[0])),
    ).not.toThrow();
  });
});
