import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { getChecksReport, getTasksReport, getTaskUpdatesReport } = await import(
  "./manager-reports.js"
);

/**
 * @param {{ accessLevel?: string, query?: Record<string, string> }} [options]
 */
function event(options = {}) {
  return /** @type {any} */ ({
    queryStringParameters: options.query,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "custom:siteId": "site-1",
            accessLevel: options.accessLevel ?? "manager",
            sub: "manager-1",
          },
        },
      },
    },
  });
}

/** @param {any} handler @param {any} e @returns {Promise<any>} */
const call = (handler, e) => handler(e, /** @type {any} */ ({}), () => {});

/**
 * Pick the QueryCommand calls out of the mock, in order.
 * @returns {any[]}
 */
const queries = () =>
  send.mock.calls
    .map((args) => args[0])
    .filter((cmd) => cmd instanceof QueryCommand);

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  // Wednesday 2026-09-30, 10:00 Pacific.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T17:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("getChecksReport", () => {
  it("refuses general devices", async () => {
    const res = await call(getChecksReport, event({ accessLevel: "general" }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "manager_access_required" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an unknown period or a malformed start day", async () => {
    const bad = await call(
      getChecksReport,
      event({ query: { period: "year" } }),
    );
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ error: "invalid_period" });
    const badStart = await call(
      getChecksReport,
      event({ query: { period: "week", start: "2026-02-30" } }),
    );
    expect(badStart.statusCode).toBe(400);
    expect(JSON.parse(badStart.body)).toEqual({ error: "invalid_start" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reads the site cadence and both periods from the GSI1 checks partition", async () => {
    send.mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({
          Item: {
            compliance: {
              requiredChecksPerDay: 3,
              perimeterChecksRequired: true,
              periodStart: "2026-07-01",
            },
          },
        });
      }
      const from = cmd.input.ExpressionAttributeValues[":from"];
      if (from.startsWith("2026-09-27")) {
        return Promise.resolve({
          Items: [
            // Sunday Sep 27: complete.
            header("a", "2026-09-27T15:00:00.000Z", 2),
            header("b", "2026-09-27T19:00:00.000Z"),
            header("c", "2026-09-28T05:00:00.000Z"), // 22:00 PDT Sep 27
            // Monday Sep 28: partial. Tuesday Sep 29: missed.
            header("d", "2026-09-28T16:00:00.000Z"),
            // Today: one check so far; one report; one unfinished check.
            header("f", "2026-09-30T15:00:00.000Z"),
            header("g", "2026-09-30T16:00:00.000Z", 1, "single-problem"),
            {
              checkId: "h",
              status: "in_progress",
              startedAt: "2026-09-30T16:30:00.000Z",
            },
          ],
        });
      }
      return Promise.resolve({
        Items: [
          header("p1", "2026-09-21T15:00:00.000Z"),
          header("p2", "2026-09-21T18:00:00.000Z"),
          header("p3", "2026-09-21T21:00:00.000Z"),
        ],
      });
    });

    const res = await call(
      getChecksReport,
      event({ query: { period: "week", start: "2026-09-30" } }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    expect(body.period).toEqual({
      kind: "week",
      start: "2026-09-27",
      endExclusive: "2026-10-04",
    });
    expect(body.today).toBe("2026-09-30");
    expect(body.requirement).toEqual({
      requiredPerDay: 3,
      required: true,
      periodStart: "2026-07-01",
    });
    expect(body.days.map((/** @type {any} */ d) => [d.date, d.status])).toEqual(
      [
        ["2026-09-27", "complete"],
        ["2026-09-28", "partial"],
        ["2026-09-29", "missed"],
        ["2026-09-30", "pending"],
        ["2026-10-01", "upcoming"],
        ["2026-10-02", "upcoming"],
        ["2026-10-03", "upcoming"],
      ],
    );
    expect(body.days[3]).toMatchObject({
      completed: 1,
      reports: 1,
      issueCount: 1,
    });
    expect(body.totals).toEqual({
      possible: 12,
      completed: 5,
      recorded: 5,
      missed: 5,
      issueCount: 3,
    });
    expect(body.previous).toMatchObject({
      start: "2026-09-20",
      endExclusive: "2026-09-27",
      totals: { possible: 21, completed: 3, missed: 18 },
    });

    // Raw headers never leave the handler.
    expect(res.body).not.toContain('"startedAt"');

    const [current, previous] = queries();
    expect(current.input.IndexName).toBe("GSI1");
    expect(current.input.KeyConditionExpression).toBe(
      "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to",
    );
    expect(current.input.ExpressionAttributeValues).toEqual({
      ":pk": "SITE#site-1",
      ":from": "2026-09-27T07:00:00.000Z",
      ":to": "2026-10-04T07:00:00.000Z",
    });
    expect(previous.input.ExpressionAttributeValues[":from"]).toBe(
      "2026-09-20T07:00:00.000Z",
    );
  });

  it("defaults to the current month and follows pagination cursors", async () => {
    send.mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) return Promise.resolve({ Item: {} });
      if (cmd.input.ExclusiveStartKey) return Promise.resolve({ Items: [] });
      return Promise.resolve({
        Items: [],
        ...(cmd.input.ExpressionAttributeValues[":from"].startsWith("2026-09")
          ? { LastEvaluatedKey: { pk: "x", sk: "y" } }
          : {}),
      });
    });

    const res = await call(getChecksReport, event());
    const body = JSON.parse(res.body);
    expect(body.period).toEqual({
      kind: "month",
      start: "2026-09-01",
      endExclusive: "2026-10-01",
    });
    expect(body.days).toHaveLength(30);
    // No cadence on the site: every day is exempt, nothing is owed.
    expect(
      body.days.every((/** @type {any} */ d) => d.status === "exempt"),
    ).toBe(true);
    expect(body.totals.possible).toBe(0);
    // Current month needed two pages, previous month one. Both periods
    // query concurrently, so only the cursor page's position is stable.
    expect(queries()).toHaveLength(3);
    const cursorPage = queries().find((q) => q.input.ExclusiveStartKey);
    expect(cursorPage.input.ExclusiveStartKey).toEqual({ pk: "x", sk: "y" });
    expect(cursorPage.input.ExpressionAttributeValues[":from"]).toBe(
      "2026-09-01T07:00:00.000Z",
    );
  });

  it("drops an item stamped exactly on the next period's first midnight", async () => {
    send.mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({
          Item: { compliance: { requiredChecksPerDay: 1 } },
        });
      }
      if (
        cmd.input.ExpressionAttributeValues[":from"].startsWith("2026-09-27")
      ) {
        return Promise.resolve({
          Items: [
            {
              ...header("edge", "2026-10-04T07:00:00.000Z"),
              gsi1sk: "2026-10-04T07:00:00.000Z",
            },
          ],
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const res = await call(
      getChecksReport,
      event({ query: { period: "week", start: "2026-09-30" } }),
    );
    const body = JSON.parse(res.body);
    expect(body.totals.recorded).toBe(0);
  });
});

describe("getTasksReport", () => {
  it("queries the task timeline partition with a projection and counts the previous period", async () => {
    send.mockImplementation((cmd) => {
      const from = cmd.input.ExpressionAttributeValues[":from"];
      return Promise.resolve({
        Items: from.startsWith("2026-07")
          ? [
              {
                taskId: "t1",
                category: "Litter",
                status: "completed",
                gsi1sk: "2026-08-01T15:00:00.000Z#t1",
              },
              {
                taskId: "t2",
                category: "Graffiti",
                status: "open",
                gsi1sk: "2026-09-01T15:00:00.000Z#t2",
              },
            ]
          : [{ taskId: "old", gsi1sk: "2026-05-01T15:00:00.000Z#old" }],
      });
    });

    const res = await call(
      getTasksReport,
      event({ query: { period: "quarter", start: "2026-08-15" } }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.period).toEqual({
      kind: "quarter",
      start: "2026-07-01",
      endExclusive: "2026-10-01",
    });
    expect(body.tasks.map((/** @type {any} */ t) => t.taskId)).toEqual([
      "t1",
      "t2",
    ]);
    expect(body.previous).toEqual({
      kind: "quarter",
      start: "2026-04-01",
      endExclusive: "2026-07-01",
      count: 1,
    });

    const [current, previous] = queries();
    expect(current.input.ExpressionAttributeValues[":pk"]).toBe(
      "SITE#site-1#TASK",
    );
    expect(current.input.ProjectionExpression).toContain("#shortId");
    expect(current.input.ExpressionAttributeNames["#status"]).toBe("status");
    expect(previous.input.ProjectionExpression).toBe("#taskId");
  });

  it("refuses general devices", async () => {
    const res = await call(getTasksReport, event({ accessLevel: "general" }));
    expect(res.statusCode).toBe(403);
  });
});

describe("getTaskUpdatesReport", () => {
  it("queries the update timeline partition", async () => {
    send.mockImplementation((cmd) =>
      Promise.resolve({
        Items: cmd.input.ExpressionAttributeValues[":from"].startsWith(
          "2026-09",
        )
          ? [
              {
                updateId: "u1",
                type: "task_completed",
                gsi1sk: "2026-09-02T15:00:00.000Z#u1",
              },
            ]
          : [],
      }),
    );
    const res = await call(
      getTaskUpdatesReport,
      event({ query: { period: "month", start: "2026-09-10" } }),
    );
    const body = JSON.parse(res.body);
    expect(body.updates).toHaveLength(1);
    expect(body.previous).toEqual({
      kind: "month",
      start: "2026-08-01",
      endExclusive: "2026-09-01",
      count: 0,
    });
    const [current] = queries();
    expect(current.input.ExpressionAttributeValues[":pk"]).toBe(
      "SITE#site-1#UPDATE",
    );
    expect(current.input.ExpressionAttributeNames["#type"]).toBe("type");
  });

  it("refuses general devices", async () => {
    const res = await call(
      getTaskUpdatesReport,
      event({ accessLevel: "general" }),
    );
    expect(res.statusCode).toBe(403);
  });
});

/**
 * @param {string} checkId
 * @param {string} startedAt
 * @param {number} [issueCount]
 * @param {string} [flowType]
 */
function header(checkId, startedAt, issueCount = 0, flowType = "perimeter") {
  return {
    checkId,
    status: "completed",
    startedAt,
    completedAt: startedAt,
    issueCount,
    flowType,
    gsi1sk: startedAt,
  };
}
