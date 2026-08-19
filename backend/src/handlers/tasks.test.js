import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Document Client so the handler's read hits a spy, not AWS.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { listTasks } = await import("./tasks.js");

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
        { taskId: "t-new-low-1", severity: 1, createdAt: "2026-08-19T00:00:00.000Z" },
        { taskId: "t-new-low-2", severity: 1, createdAt: "2026-08-18T00:00:00.000Z" },
        { taskId: "t-old-high", severity: 5, createdAt: "2026-08-01T00:00:00.000Z" },
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
      Items: [{ taskId: "t1", severity: 3, createdAt: "2026-08-19T00:00:00.000Z" }],
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
