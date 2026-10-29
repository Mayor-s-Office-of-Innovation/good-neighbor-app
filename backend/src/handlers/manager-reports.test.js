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
      if (cmd.input.ExpressionAttributeValues[":prefix"]) {
        return Promise.resolve({
          Items: [
            {
              termsVersionId: "current",
              effectiveStart: "2026-07-01",
              requiredChecksPerDay: 3,
              status: "active",
            },
          ],
        });
      }
      const from = cmd.input.ExpressionAttributeValues[":from"];
      if (from.startsWith("2026-09-27")) {
        return Promise.resolve({
          Items: [
            // Sunday Sep 27: complete.
            {
              ...header("a", "2026-09-27T15:00:00.000Z", 2),
              photoCount: 5,
              privateField: "not exposed",
            },
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
    expect(body.days[0].checks[0]).toEqual({
      checkId: "a",
      startedAt: "2026-09-27T15:00:00.000Z",
      photoCount: 5,
    });
    expect(body.days[0].checks[0]).not.toHaveProperty("privateField");
    expect(body.requirement).toEqual({
      requiredPerDay: 3,
      required: true,
      assumed: false,
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
    expect(res.body).not.toContain('"privateField"');

    const [current, previous, terms] = queries();
    expect(current.input.IndexName).toBe("GSI1");
    expect(current.input.KeyConditionExpression).toBe(
      "gsi1pk = :pk AND gsi1sk BETWEEN :from AND :to",
    );
    expect(terms.input.KeyConditionExpression).toBe(
      "pk = :pk AND begins_with(sk, :prefix)",
    );
    expect(terms.input.ExpressionAttributeValues).toEqual({
      ":pk": "SITE#site-1",
      ":prefix": "COMPLIANCE_TERMS#",
    });
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
      if (cmd.input.ExpressionAttributeValues[":prefix"]) {
        return Promise.resolve({ Items: [] });
      }
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
    // No canonical period means no requirement; do not invent a default duty.
    expect(body.requirement).toMatchObject({
      requiredPerDay: 0,
      assumed: false,
    });
    expect(body.days[0].required).toBe(0);
    expect(body.totals.possible).toBe(0);
    // Current month needed two pages, previous month one, plus the terms
    // read. Both periods query concurrently, so only the cursor page's
    // position is stable.
    expect(queries()).toHaveLength(4);
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
        cmd.input.ExpressionAttributeValues[":from"]?.startsWith("2026-09-27")
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

  it("judges past days by the terms in force then, not today's projection", async () => {
    send.mockImplementation((cmd) => {
      if (cmd instanceof GetCommand) {
        // The projection was nulled when the first period ended; the new
        // terms start Sep 29.
        return Promise.resolve({
          Item: {
            compliance: {
              perimeterChecksRequired: true,
              periodStart: "2026-09-29",
              requiredChecksPerDay: 3,
            },
          },
        });
      }
      if (cmd.input.ExpressionAttributeValues[":prefix"]) {
        return Promise.resolve({
          Items: [
            {
              effectiveStart: "2026-09-01",
              expiresOnExclusive: "2026-09-28",
              requiredChecksPerDay: 1,
              status: "expired",
            },
            {
              effectiveStart: "2026-09-29",
              requiredChecksPerDay: 3,
              status: "active",
            },
          ],
        });
      }
      if (
        cmd.input.ExpressionAttributeValues[":from"].startsWith("2026-09-27")
      ) {
        return Promise.resolve({
          Items: [
            header("a", "2026-09-27T15:00:00.000Z"),
            header("b", "2026-09-29T15:00:00.000Z"),
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
    expect(body.requirement).toMatchObject({ assumed: false });
    expect(
      body.days.map((/** @type {any} */ d) => [d.date, d.required, d.status]),
    ).toEqual([
      ["2026-09-27", 1, "complete"], // old cadence, met
      ["2026-09-28", 0, "exempt"], // between the two periods
      ["2026-09-29", 3, "partial"], // new cadence
      ["2026-09-30", 3, "pending"],
      ["2026-10-01", 3, "upcoming"],
      ["2026-10-02", 3, "upcoming"],
      ["2026-10-03", 3, "upcoming"],
    ]);
    expect(body.totals).toMatchObject({ possible: 7, completed: 2, missed: 2 });
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
          : [
              {
                taskId: "old",
                category: "Litter",
                status: "completed",
                gsi1sk: "2026-05-01T15:00:00.000Z#old",
              },
              {
                taskId: "old-unlabeled",
                status: "completed",
                gsi1sk: "2026-05-01T16:00:00.000Z#old-unlabeled",
              },
              // Replaced by an amendment: not an issue, so not counted,
              // matching the current list's definition.
              {
                taskId: "old-superseded",
                status: "superseded",
                gsi1sk: "2026-05-02T15:00:00.000Z#old-superseded",
              },
            ],
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
      count: 2,
      // Per type, for the type screen's delta; no category falls to "other".
      byType: { Litter: 1, other: 1 },
    });

    const [current, previous] = queries();
    expect(current.input.ExpressionAttributeValues[":pk"]).toBe(
      "SITE#site-1#TASK",
    );
    expect(current.input.ProjectionExpression).toContain("#shortId");
    // The day detail's task cards and 311 sheet need the filed ticket.
    expect(current.input.ProjectionExpression).toContain("#appActionResults");
    expect(current.input.ProjectionExpression).toContain("#guidance");
    expect(current.input.ExpressionAttributeNames["#status"]).toBe("status");
    expect(previous.input.ProjectionExpression).toBe(
      "#taskId, #status, #category, #userFriendlyLabel",
    );
  });

  it("refuses general devices", async () => {
    const res = await call(getTasksReport, event({ accessLevel: "general" }));
    expect(res.statusCode).toBe(403);
  });
});

describe("elapsed-period comparisons", () => {
  it.each([
    [
      "month",
      "2026-10-01",
      "2026-09-01T07:00:00.000Z",
      "2026-09-27T07:00:00.000Z",
    ],
    [
      "week",
      "2026-10-25",
      "2026-10-18T07:00:00.000Z",
      "2026-10-20T07:00:00.000Z",
    ],
    [
      "quarter",
      "2026-10-01",
      "2026-07-01T07:00:00.000Z",
      "2026-07-27T07:00:00.000Z",
    ],
  ])(
    "compares matching elapsed days for %s",
    async (period, start, from, to) => {
      vi.setSystemTime(new Date("2026-10-26T18:00:00Z"));
      send.mockResolvedValue({ Items: [] });
      const res = await call(
        getTasksReport,
        event({ query: { period, start } }),
      );
      const body = JSON.parse(res.body);
      expect(body.asOf).toBe("2026-10-26T18:00:00.000Z");
      expect(queries()[1].input.ExpressionAttributeValues).toMatchObject({
        ":from": from,
        ":to": to,
      });
    },
  );

  it("uses the full previous period for a completed month and caps shorter months", async () => {
    vi.setSystemTime(new Date("2026-10-31T18:00:00Z"));
    send.mockResolvedValue({ Items: [] });
    const res = await call(
      getTasksReport,
      event({ query: { period: "month", start: "2026-09-01" } }),
    );
    expect(JSON.parse(res.body).asOf).toBe("2026-10-01T06:59:59.999Z");
    expect(queries()[1].input.ExpressionAttributeValues[":to"]).toBe(
      "2026-09-01T07:00:00.000Z",
    );
    send.mockClear();
    await call(
      getTasksReport,
      event({ query: { period: "month", start: "2026-10-01" } }),
    );
    expect(queries()[1].input.ExpressionAttributeValues[":to"]).toBe(
      "2026-10-01T07:00:00.000Z",
    );
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

it("includes saved and legacy proof state in report cards", async () => {
  const rows = [
    {
      taskId: "saved",
      status: "completed",
      canBeInProgress: false,
      proofAddedAt: "2026-09-20",
    },
    {
      taskId: "legacy",
      status: "completed",
      canBeInProgress: false,
      latestUpdateId: "done",
    },
    { taskId: "pending", status: "completed", canBeInProgress: false },
  ];
  send.mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      if (command.input.Key?.sk === "legacy-update")
        return {
          Item: {
            type: "task_completed",
            notes: ["Cleaned"],
            occurredAt: "2026-09-19",
          },
        };
      return { Item: { updateSk: "legacy-update" } };
    }
    const projection = command.input.ProjectionExpression || "";
    if (!projection.includes("#latestUpdateId")) return { Items: [] };
    for (const field of ["proofAddedAt", "canBeInProgress", "latestUpdateId"])
      expect(projection).toContain(`#${field}`);
    // DynamoDB applies the projection, so returning only its selected fields
    // makes this test catch accidentally omitted proof metadata.
    const included = new Set(
      Object.values(command.input.ExpressionAttributeNames),
    );
    return {
      Items: rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).filter(([key]) => included.has(key)),
        ),
      ),
    };
  });
  const response = await call(
    getTasksReport,
    event({ query: { period: "month", start: "2026-09-01" } }),
  );
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).tasks).toEqual([
    rows[0],
    { ...rows[1], proofAddedAt: "2026-09-19" },
    { ...rows[2], proofAddedAt: null },
  ]);
});
