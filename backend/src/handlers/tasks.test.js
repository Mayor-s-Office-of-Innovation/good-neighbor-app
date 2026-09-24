import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Document Client so the handler's read hits a spy, not AWS.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { get311RequestDetail, get311RequestDetails, listTasks } = await import(
  "./tasks.js"
);

/**
 * @param {object} opts
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @param {Record<string, string>} [opts.query] queryStringParameters
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function readEvent({ siteClaim, query }) {
  return /** @type {any} */ ({
    ...(query ? { queryStringParameters: query } : {}),
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
  });
}

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const invoke = (event) =>
  /** @type {any} */ (listTasks(event, /** @type {any} */ ({}), () => {}));

describe("listTasks", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "gnp-test-app";
  });

  it("queries GSI2 for the site's open worklist", async () => {
    send.mockResolvedValueOnce({ Items: [] });

    const res = await invoke(readEvent({ siteClaim: "site-1" }));

    expect(res.statusCode).toBe(200);
    const q = send.mock.calls[0][0];
    expect(q).toBeInstanceOf(QueryCommand);
    expect(q.input.IndexName).toBe("GSI2");
    expect(q.input.KeyConditionExpression).toBe("gsi2pk = :pk");
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe(
      "SITE#site-1#TASK#open",
    );
  });

  // A DynamoDB Limit would truncate by index order (date-first), so the most-severe
  // task could fall outside the page. The handler must never set one — `limit` is a
  // post-sort slice instead (see the "limit slices after the severity sort" test).
  it("never sends a DynamoDB Limit, even when the client asks for one", async () => {
    send.mockResolvedValueOnce({ Items: [] });

    await invoke(readEvent({ siteClaim: "site-1", query: { limit: "50" } }));

    const q = send.mock.calls[0][0];
    expect(q.input.Limit).toBeUndefined();
  });

  it("honors an explicit status", async () => {
    send.mockResolvedValueOnce({ Items: [] });

    await invoke(readEvent({ siteClaim: "site-1", query: { status: "done" } }));

    const q = send.mock.calls[0][0];
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe(
      "SITE#site-1#TASK#done",
    );
  });

  // Regression: GSI2's sort key is date-first, so the index cannot order by
  // severity. The handler must re-order the fetched page most-severe first
  // (newest first within a severity) to satisfy AP10.
  it("returns the worklist most-severe first, newest first within a severity", async () => {
    send.mockResolvedValueOnce({
      Items: [
        { taskId: "t-low", severity: 1, createdAt: "2026-08-18T00:00:00.000Z" },
        {
          taskId: "t-high-old",
          severity: 4,
          createdAt: "2026-08-10T00:00:00.000Z",
        },
        {
          taskId: "t-high-new",
          severity: 4,
          createdAt: "2026-08-15T00:00:00.000Z",
        },
        { taskId: "t-mid", severity: 2, createdAt: "2026-08-19T00:00:00.000Z" },
      ],
    });

    const res = await invoke(readEvent({ siteClaim: "site-1" }));

    const order = /** @type {any[]} */ (JSON.parse(res.body).tasks).map(
      (t) => t.taskId,
    );
    expect(order).toEqual(["t-high-new", "t-high-old", "t-mid", "t-low"]);
  });

  // The core reason Limit can't be pushed to DynamoDB: an OLD high-severity task
  // must survive a small `limit`, even though newer low-severity tasks would
  // outrank it in the index's date-first order.
  it("slices to `limit` AFTER the severity sort, keeping an old high-severity task", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          taskId: "t-new-low-1",
          severity: 1,
          createdAt: "2026-08-19T00:00:00.000Z",
        },
        {
          taskId: "t-new-low-2",
          severity: 1,
          createdAt: "2026-08-18T00:00:00.000Z",
        },
        {
          taskId: "t-old-high",
          severity: 5,
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    const res = await invoke(
      readEvent({ siteClaim: "site-1", query: { limit: "2" } }),
    );

    const tasks = JSON.parse(res.body).tasks;
    expect(tasks).toHaveLength(2);
    // The old sev-5 task ranks first and is kept; a date-first Limit would have
    // dropped it in favor of the two newest low-severity tasks.
    expect(tasks[0].taskId).toBe("t-old-high");
    expect(tasks[1].taskId).toBe("t-new-low-1");
  });

  it("warns (does not silently truncate) when the partition exceeds one page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    send.mockResolvedValueOnce({
      Items: [
        { taskId: "t1", severity: 3, createdAt: "2026-08-19T00:00:00.000Z" },
      ],
      LastEvaluatedKey: { gsi2pk: "SITE#site-1#TASK#open" },
    });

    const res = await invoke(readEvent({ siteClaim: "site-1" }));

    expect(res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SITE#site-1#TASK#open exceeded one page"),
    );
    warn.mockRestore();
  });
});

describe("get311RequestDetail", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "gnp-test-app";
    process.env.SF311_CREATESR_URL = "https://hub.test/create";
    process.env.SF311_AGENCY_LOOKUP_URL = "https://hub.test/lookup";
    process.env.SF311_LATEST_UPDATES_URL = "https://hub.test/latest/{agencyID}";
    process.env.SF311_BASIC_AUTH_USER = "user";
    process.env.SF311_BASIC_AUTH_PASS = "pass";
  });

  it("does not call 311 unless the site-scoped task owns the request number", async () => {
    send.mockResolvedValueOnce({
      Item: { taskId: "task-1", appActionResults: [] },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const event = /** @type {any} */ ({
      ...readEvent({ siteClaim: "site-1" }),
      pathParameters: { taskId: "task-1", srNum: "someone-elses-ticket" },
    });
    const response = await /** @type {any} */ (
      get311RequestDetail(event, /** @type {any} */ ({}), () => {})
    );
    expect(response.statusCode).toBe(404);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input.Key).toEqual({
      pk: "SITE#site-1",
      sk: "TASK#task-1",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("coalesces the agency feed while batching site-owned requests", async () => {
    const ownedTasks = ["task-1", "task-2", "task-1", "task-2"].map(
      (taskId, index) => ({
        Item: {
          taskId,
          appActionResults: [
            {
              code: "create_311_ticket",
              payload: { tickets: [{ srNum: index % 2 ? "SR-2" : "SR-1" }] },
            },
          ],
        },
      }),
    );
    for (const result of ownedTasks) send.mockResolvedValueOnce(result);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            return_code: 0,
            requests: [
              { SRNum: "SR-1", Status: "9" },
              { SRNum: "SR-2", Status: "5" },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const event = /** @type {any} */ ({
      ...readEvent({ siteClaim: "site-1" }),
      body: JSON.stringify({
        requests: [
          { taskId: "task-1", srNum: "SR-1" },
          { taskId: "task-2", srNum: "SR-2" },
        ],
      }),
    });

    const [response, concurrentResponse] = await Promise.all([
      /** @type {any} */ (
        get311RequestDetails(event, /** @type {any} */ ({}), () => {})
      ),
      /** @type {any} */ (
        get311RequestDetails(event, /** @type {any} */ ({}), () => {})
      ),
    ]);

    expect(response.statusCode).toBe(200);
    expect(concurrentResponse.statusCode).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.body).requests).toMatchObject([
      { taskId: "task-1", request: { status: "Open" } },
      { taskId: "task-2", request: { status: "In progress" } },
    ]);
    fetchSpy.mockRestore();
  });
});
