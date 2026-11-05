import { describe, expect, it } from "vitest";
import { buildIssueFacts } from "./issue-facts.js";

const EVALUATED = "2026-10-20T00:00:00.000Z";
const CREATED = "2026-10-01T16:00:00.000Z";

/**
 * @param {Partial<import("./issue-facts.js").TaskRow>} overrides
 * @returns {import("./issue-facts.js").TaskRow}
 */
function task(overrides) {
  return {
    siteId: "s1",
    taskId: "t1",
    status: "open",
    createdAt: CREATED,
    category: "litter",
    severity: 2,
    kind: "action",
    type: "onsite",
    checkId: "c1",
    assessmentId: "a1",
    conditionId: "k1",
    ...overrides,
  };
}

/**
 * @param {Partial<import("./issue-facts.js").IssueInputs>} overrides
 * @returns {import("./issue-facts.js").IssueInputs}
 */
function inputs(overrides) {
  return {
    tasks: [],
    conditions: [],
    updates: [],
    links: [],
    overrides: [],
    checks: [{ siteId: "s1", checkId: "c1", flowType: "perimeter" }],
    ...overrides,
  };
}

describe("buildIssueFacts", () => {
  it("counts one Issue per live condition, keeping the first task listed", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t2" }),
          task({ taskId: "t1", createdAt: "2026-10-02T00:00:00.000Z" }),
        ],
        conditions: [
          {
            siteId: "s1",
            assessmentId: "a1",
            conditionId: "k1",
            taskIds: ["t1", "t2"],
          },
        ],
      }),
      EVALUATED,
    );
    // The app lists the first task first; its clock starts the deadline.
    expect(
      issues.map((i) => [
        i.issueId,
        i.followUpTasks,
        i.createdAt,
        i.deadlineAt,
      ]),
    ).toEqual([
      ["t1", 1, "2026-10-02T00:00:00.000Z", "2026-10-05T00:00:00.000Z"],
    ]);
    expect(dropped.followUp).toBe(1);
  });

  it("times the Issue by its first task's rule, not a follow-up's", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            taskId: "t1",
            ruleId: "MED-1",
            maxAcceptableResponseHours: 0,
          }),
          task({
            taskId: "t2",
            ruleId: "BLOCK-1",
            maxAcceptableResponseHours: 4,
            createdAt: "2026-10-01T17:00:00.000Z",
          }),
        ],
        conditions: [
          {
            siteId: "s1",
            assessmentId: "a1",
            conditionId: "k1",
            taskIds: ["t1", "t2"],
          },
        ],
      }),
      EVALUATED,
    );
    expect(
      issues.map((i) => [i.issueId, i.deadlineAt, i.responseState]),
    ).toEqual([["t1", null, "notTimed"]]);
  });

  it("keeps the earliest task when the condition record is missing", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1", createdAt: "2026-10-02T00:00:00.000Z" }),
          task({ taskId: "t2" }),
        ],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => i.issueId)).toEqual(["t2"]);
  });

  it("folds a sighting linked to a follow-up task into that task's Issue", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t4", conditionId: "k4" }),
          task({ taskId: "t3", conditionId: "k3" }),
          task({ taskId: "t2", conditionId: "k3" }),
          task({ taskId: "t1", conditionId: "k1" }),
        ],
        conditions: [
          {
            siteId: "s1",
            assessmentId: "a1",
            conditionId: "k3",
            taskIds: ["t3", "t2"],
          },
        ],
        links: [
          { siteId: "s1", taskId: "t1", originalTaskId: "t2" },
          { siteId: "s1", taskId: "t3", originalTaskId: "t4" },
        ],
      }),
      EVALUATED,
    );
    expect(
      issues.map((i) => [i.issueId, i.sightings, i.followUpTasks]),
    ).toEqual([["t4", 3, 1]]);
    expect(dropped).toMatchObject({ duplicate: 2, followUp: 1 });
  });

  it("leaves out superseded and deleted tasks", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1", status: "superseded" }),
          task({ taskId: "t2", status: "deleted", conditionId: "k2" }),
          task({ taskId: "t3", conditionId: "k3" }),
        ],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => i.issueId)).toEqual(["t3"]);
    expect(dropped).toMatchObject({ superseded: 1, deleted: 1 });
  });

  it("leaves out a task with no usable creation time, and says so", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1", createdAt: /** @type {any} */ (undefined) }),
          task({ taskId: "t2" }),
        ],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => i.issueId)).toEqual(["t2"]);
    expect(dropped.undated).toBe(1);
  });

  it("marks an Issue reopened only when its own task was closed and reopened", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1" }),
          task({
            taskId: "t2",
            status: "completed",
            completedAt: "2026-10-02T00:00:00.000Z",
            createdAt: "2026-10-01T17:00:00.000Z",
          }),
        ],
        conditions: [
          {
            siteId: "s1",
            assessmentId: "a1",
            conditionId: "k1",
            taskIds: ["t1", "t2"],
          },
        ],
        updates: [
          {
            siteId: "s1",
            taskId: "t2",
            type: "task_completed",
            occurredAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({ issueId: "t1", reopened: false });
  });

  it("marks an Issue's source unknown when its Check isn't in the lake", () => {
    const { issues } = buildIssueFacts(
      inputs({ tasks: [task({})], checks: [] }),
      EVALUATED,
    );
    expect(issues[0].source).toBe("unknown");
  });

  it("marks an Issue from a single-problem report as such", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [task({})],
        checks: [{ siteId: "s1", checkId: "c1", flowType: "single-problem" }],
      }),
      EVALUATED,
    );
    expect(issues[0].source).toBe("single-problem");
  });

  it("treats a parent Check with no flow type as a perimeter Check", () => {
    for (const flowType of [null, "PERIMETER"]) {
      const { issues } = buildIssueFacts(
        inputs({
          tasks: [task({})],
          checks: [{ siteId: "s1", checkId: "c1", flowType }],
        }),
        EVALUATED,
      );
      expect(issues[0].source).toBe("perimeter");
    }
  });

  it("folds a linked duplicate sighting into the earlier Issue", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1" }),
          task({
            taskId: "t2",
            conditionId: "k2",
            createdAt: "2026-10-02T16:00:00.000Z",
            status: "in_progress",
            inProgressAt: "2026-10-03T00:00:00.000Z",
          }),
        ],
        links: [{ siteId: "s1", taskId: "t2", originalTaskId: "t1" }],
      }),
      EVALUATED,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      issueId: "t1",
      sightings: 2,
      firstResponseAt: "2026-10-03T00:00:00.000Z",
      responseState: "onTime",
    });
    expect(dropped.duplicate).toBe(1);
  });

  it("counts a separated sighting as its own Issue", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1" }),
          task({ taskId: "t2", conditionId: "k2" }),
        ],
        links: [{ siteId: "s1", taskId: "t2", originalTaskId: "t1" }],
        overrides: [{ siteId: "s1", taskId: "t2" }],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => i.issueId)).toEqual(["t1", "t2"]);
  });

  it("keeps a sighting as its own Issue when its original was deleted", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1", status: "deleted" }),
          task({ taskId: "t2", conditionId: "k2" }),
        ],
        links: [{ siteId: "s1", taskId: "t2", originalTaskId: "t1" }],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => i.issueId)).toEqual(["t2"]);
  });

  it("treats every task in a link cycle as its own Issue", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t1" }),
          task({ taskId: "t2", conditionId: "k2" }),
        ],
        links: [
          { siteId: "s1", taskId: "t1", originalTaskId: "t2" },
          { siteId: "s1", taskId: "t2", originalTaskId: "t1" },
        ],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => [i.issueId, i.sightings])).toEqual([
      ["t1", 1],
      ["t2", 1],
    ]);
    expect(dropped.duplicate).toBe(0);
  });

  it("follows links past a replaced sighting to the last original", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t3", conditionId: "k3" }),
          task({ taskId: "t2", conditionId: "k2", status: "superseded" }),
          task({
            taskId: "t1",
            createdAt: "2026-10-02T16:00:00.000Z",
          }),
        ],
        links: [
          { siteId: "s1", taskId: "t1", originalTaskId: "t2" },
          { siteId: "s1", taskId: "t2", originalTaskId: "t3" },
        ],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => [i.issueId, i.sightings])).toEqual([["t3", 2]]);
  });

  it("keeps a sighting alone when the last original was deleted", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({ taskId: "t3", conditionId: "k3", status: "deleted" }),
          task({ taskId: "t2", conditionId: "k2" }),
          task({
            taskId: "t1",
            createdAt: "2026-10-02T16:00:00.000Z",
          }),
        ],
        links: [
          { siteId: "s1", taskId: "t1", originalTaskId: "t2" },
          { siteId: "s1", taskId: "t2", originalTaskId: "t3" },
        ],
      }),
      EVALUATED,
    );
    expect(issues.map((i) => i.issueId)).toEqual(["t2", "t1"]);
  });

  it("takes the first staff response from the timeline, not later notes or edits", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            status: "completed",
            inProgressAt: "2026-10-05T00:00:00.000Z",
            completedAt: "2026-10-06T00:00:00.000Z",
          }),
        ],
        updates: [
          {
            siteId: "s1",
            taskId: "t1",
            type: "duplicate_detected",
            occurredAt: "2026-10-01T17:00:00.000Z",
          },
          {
            siteId: "s1",
            taskId: "t1",
            type: "escalation_action_taken",
            occurredAt: "2026-10-04T16:00:00.000Z",
          },
          {
            siteId: "s1",
            taskId: "t1",
            type: "note_photo_update",
            occurredAt: "2026-10-04T18:00:00.000Z",
          },
        ],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      firstResponseAt: "2026-10-04T16:00:00.000Z",
      responseBasis: "timeline",
      responseState: "onTime",
      resolvedAt: "2026-10-06T00:00:00.000Z",
    });
  });

  it("counts a direct move to history as the first response", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            status: "completed",
            completedAt: "2026-10-04T16:00:01.000Z",
            resolvedAt: "2026-10-04T16:00:01.000Z",
          }),
        ],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      responseBasis: "task_record",
      responseState: "late",
    });
  });

  it("keeps a late first response late after the Issue is reopened", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            status: "in_progress",
            inProgressAt: "2026-10-12T00:00:00.000Z",
          }),
        ],
        updates: [
          {
            siteId: "s1",
            taskId: "t1",
            type: "task_completed",
            occurredAt: "2026-10-05T00:00:00.000Z",
          },
          {
            siteId: "s1",
            taskId: "t1",
            type: "presence_still_present",
            occurredAt: "2026-10-12T00:00:00.000Z",
          },
        ],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      firstResponseAt: "2026-10-05T00:00:00.000Z",
      responseState: "late",
      reopened: true,
      resolvedAt: null,
    });
  });

  it("marks a response with no recorded time as unknown", () => {
    const { issues } = buildIssueFacts(
      inputs({ tasks: [task({ status: "in_progress" })] }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      firstResponseAt: null,
      responseState: "unknown",
    });
  });

  it("judges each Issue at the snapshot time, ignoring later records", () => {
    const { issues, dropped } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            status: "completed",
            completedAt: "2026-10-05T00:00:00.000Z",
          }),
          task({
            taskId: "t9",
            conditionId: "k9",
            createdAt: "2026-10-03T00:00:00.000Z",
          }),
          task({
            taskId: "t10",
            conditionId: "k10",
            createdAt: "2026-10-03T00:00:00.001Z",
          }),
        ],
      }),
      "2026-10-03T00:00:00.000Z",
    );
    expect(
      issues.map((i) => [i.issueId, i.responseState, i.firstResponseAt]),
    ).toEqual([
      ["t1", "awaiting", null],
      ["t9", "awaiting", null],
    ]);
    expect(dropped.afterSnapshot).toBe(1);
  });

  it("counts a note before the snapshot as a response of unknown time", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            status: "completed",
            inProgressAt: "2026-10-21T00:00:00.000Z",
            completedAt: "2026-10-21T00:00:00.000Z",
          }),
        ],
        updates: [
          {
            siteId: "s1",
            taskId: "t1",
            type: "note_photo_update",
            occurredAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      firstResponseAt: null,
      responseState: "unknown",
      resolvedAt: null,
    });
  });

  it("takes the resolution time over the completion time", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [
          task({
            status: "completed",
            completedAt: "2026-10-03T00:00:00.000Z",
            resolvedAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-21T00:00:00.000Z",
          }),
        ],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      resolvedAt: "2026-10-02T00:00:00.000Z",
      // Activity after the snapshot is left out.
      latestActivityAt: "2026-10-03T00:00:00.000Z",
    });
  });

  it("buckets a winter Issue on its Pacific day", () => {
    const { issues } = buildIssueFacts(
      inputs({ tasks: [task({ createdAt: "2026-11-05T07:30:00.000Z" })] }),
      "2026-11-06T00:00:00.000Z",
    );
    expect(issues[0].createdDay).toBe("2026-11-04");
  });

  it("buckets the Issue on its Pacific creation day and band", () => {
    const { issues } = buildIssueFacts(
      inputs({
        tasks: [task({ createdAt: "2026-10-02T06:30:00.000Z", severity: 4 })],
      }),
      EVALUATED,
    );
    expect(issues[0]).toMatchObject({
      createdDay: "2026-10-01",
      severityBand: "severe",
      source: "perimeter",
    });
  });

  it.each([
    ["Large waste", "Bulky items"],
    ["Intimidation, or violence", "Threats, intimidation, or violence"],
    ["Dangerous animals", "Animals"],
    ["litter", "Litter"],
    ["Unsecured gate", "Unsecured gate"],
  ])("reports the %s category as %s", (stored, reported) => {
    const { issues } = buildIssueFacts(
      inputs({ tasks: [task({ category: stored })] }),
      EVALUATED,
    );
    expect(issues[0].category).toBe(reported);
  });
});
