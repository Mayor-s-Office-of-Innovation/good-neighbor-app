import { describe, expect, it } from "vitest";
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
 * @param {Record<string, any>[]} checks
 * @param {Record<string, any>[]} [tasks]
 */
async function buildChecks(checks, tasks = []) {
  const { tables, manifest } = await buildFromRows(
    { checks, tasks },
    EVALUATED,
  );
  return {
    checks: tables.checks,
    undatedChecks: manifest.dataQuality.undatedChecks,
  };
}

describe("checks in the projection", () => {
  it("writes the start time in the same form as the others", async () => {
    const { checks } = await buildChecks([
      check({ startedAt: "2026-11-02T10:00:00-07:00" }),
    ]);
    expect(checks[0].startedAt).toBe("2026-11-02T17:00:00.000Z");
  });

  it("gives no start time rather than an empty one", async () => {
    const { checks } = await buildChecks([check({ startedAt: "" })]);
    expect(checks[0].startedAt).toBeNull();
  });

  it("counts a Check finished after the snapshot as unfinished", async () => {
    const { checks } = await buildChecks([
      check({ completedAt: "2026-11-04T21:00:00.000Z" }),
    ]);
    expect([checks[0].state, checks[0].completedAt]).toEqual([
      "unfinished",
      null,
    ]);
  });

  it("uses the synthesis time when an older Check has no completion time", async () => {
    const { checks } = await buildChecks([
      check({ completedAt: null, synthesizedAt: "2026-11-02T17:20:00.000Z" }),
    ]);
    expect(checks[0].completedAt).toBe("2026-11-02T17:20:00.000Z");
  });

  it("dates a completed Check by completion and an unfinished one by start", async () => {
    const { checks } = await buildChecks([
      check({ checkId: "c1" }),
      check({
        checkId: "c2",
        status: "in_progress",
        startedAt: "2026-11-03T08:00:00.000Z",
        completedAt: null,
      }),
    ]);
    expect(
      checks.map((c) => [c.checkId, c.state, c.activityAt, c.day]),
    ).toEqual([
      ["c1", "completed", "2026-11-02T17:10:00.000Z", "2026-11-02"],
      ["c2", "unfinished", "2026-11-03T08:00:00.000Z", "2026-11-03"],
    ]);
  });

  it("dates a Check finished late in the evening on its Pacific day, not UTC's", async () => {
    // 11:30 PM Pacific on Nov 2 is already Nov 3 in UTC.
    const { checks } = await buildChecks([
      check({
        startedAt: "2026-11-03T07:00:00.000Z",
        completedAt: "2026-11-03T07:30:00.000Z",
      }),
    ]);
    expect(checks[0].day).toBe("2026-11-02");
  });

  it("gives no completion time to a completed Check that never recorded one", async () => {
    const { checks } = await buildChecks([check({ completedAt: null })]);
    expect([checks[0].state, checks[0].completedAt]).toEqual([
      "completed",
      null,
    ]);
  });

  it("marks single-issue reports apart from perimeter Checks", async () => {
    const { checks } = await buildChecks([
      check({ checkId: "c1", flowType: "single-problem" }),
      check({ checkId: "c2", flowType: null }),
    ]);
    expect(checks.map((c) => c.source)).toEqual([
      "single-problem",
      "perimeter",
    ]);
  });

  it("counts each Check's canonical Issues at its own Site", async () => {
    const { checks } = await buildChecks(
      [check({ checkId: "c1" }), check({ checkId: "c2" })],
      [
        task({ taskId: "t1" }),
        task({ taskId: "t2" }),
        // A replaced task is no Issue.
        task({ taskId: "t3", status: "superseded" }),
        task({ taskId: "t4", siteId: "s2", checkId: "c2" }),
      ],
    );
    expect(checks.map((c) => [c.checkId, c.issues])).toEqual([
      ["c1", 2],
      ["c2", 0],
    ]);
  });

  it("leaves out undated Checks and Checks started after the snapshot", async () => {
    const { checks, undatedChecks } = await buildChecks([
      check({ checkId: "c1" }),
      check({ checkId: "c2", startedAt: null, completedAt: null }),
      check({
        checkId: "c3",
        status: "in_progress",
        startedAt: "2026-11-05T08:00:00.000Z",
        completedAt: null,
      }),
    ]);
    expect(checks.map((c) => c.checkId)).toEqual(["c1"]);
    expect(undatedChecks).toBe(1);
  });
});
