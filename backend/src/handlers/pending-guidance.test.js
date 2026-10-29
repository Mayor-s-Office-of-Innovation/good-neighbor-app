import { beforeEach, expect, it, vi } from "vitest";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
const { send, read } = vi.hoisted(() => ({ send: vi.fn(), read: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../analysis/guidance/guidance-store.js", () => ({
  getAssessmentGuidance: read,
}));
const { listPendingGuidance } = await import("./pending-guidance.js");
const cursor = {
  pk: "SITE#site",
  sk: "ASSESSMENT#old",
  gsi1pk: "SITE#site#ASSESSMENT",
  gsi1sk: "2026-10-01#old",
};
/** @param {string | undefined} token */
const invoke = async (token) =>
  /** @type {{body: string, statusCode: number}} */ (
    await listPendingGuidance(
      /** @type {any} */ ({
        queryStringParameters: { nextToken: token, siteId: "other" },
        requestContext: {
          authorizer: { jwt: { claims: { "custom:siteId": "site" } } },
        },
      }),
      /** @type {any} */ ({}),
      () => {},
    )
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DYNAMO_TABLE", "table");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  send.mockResolvedValue({ Items: [{ assessmentId: "old" }] });
  read.mockResolvedValue({
    assessment: { assessmentId: "old", checkId: "old-check" },
    conditions: [
      {
        conditionId: "question",
        status: "needs_answer",
        needsAnswer: { key: "provider_generated" },
      },
      { conditionId: "done", status: "tasks_created" },
    ],
    tasks: [],
  });
});
it("recovers historical unanswered conditions with site-scoped queries", async () => {
  const response = await invoke(undefined);
  const body = JSON.parse(response.body);
  expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
  expect(send.mock.calls[0][0].input).toMatchObject({
    IndexName: "GSI1",
    Limit: 25,
    ExpressionAttributeValues: { ":pk": "SITE#site#ASSESSMENT" },
  });
  expect(read).toHaveBeenCalledWith({
    tableName: "table",
    siteId: "site",
    assessmentId: "old",
  });
  expect(
    body.guidance[0].conditions.map(
      (/** @type {{conditionId: string}} */ c) => c.conditionId,
    ),
  ).toEqual(["question"]);
});
it("retains pagination on an empty filtered page and resumes the supplied cursor", async () => {
  send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor });
  const first = JSON.parse((await invoke(undefined)).body);
  expect(first.guidance).toEqual([]);
  expect(first.nextToken).toBeTruthy();
  await invoke(first.nextToken);
  expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(cursor);
});
it("rejects a cursor for another site before reading", async () => {
  const token = Buffer.from(
    JSON.stringify({ ...cursor, pk: "SITE#other" }),
  ).toString("base64url");
  expect((await invoke(token)).statusCode).toBe(400);
  expect(send).not.toHaveBeenCalled();
});
it.each([null, { assessmentId: "old", supersededByAssessmentId: "new" }])(
  "omits deleted or superseded guidance: %j",
  async (assessment) => {
    read.mockResolvedValueOnce({
      assessment,
      conditions: [{ status: "needs_answer", needsAnswer: {} }],
      tasks: [],
    });
    expect(JSON.parse((await invoke(undefined)).body).guidance).toEqual([]);
  },
);
it("revalidates an answered condition despite a stale pending GSI projection", async () => {
  read.mockResolvedValueOnce({
    assessment: { assessmentId: "old" },
    conditions: [{ status: "tasks_created", needsAnswer: null }],
    tasks: [],
  });
  expect(JSON.parse((await invoke(undefined)).body).guidance).toEqual([]);
});

it("does not resurrect a question after a confirmed analyzer deletion", async () => {
  read.mockResolvedValueOnce({
    assessment: { assessmentId: "old", checkId: "old-check" },
    conditions: [
      {
        conditionId: "question",
        status: "needs_answer",
        needsAnswer: {},
        source: { artifactIds: ["artifact"] },
      },
    ],
    tasks: [],
  });
  send.mockImplementation(async (command) =>
    command instanceof GetCommand
      ? { Item: { deletedAt: "2026-10-29T12:00:00Z" } }
      : { Items: [{ assessmentId: "old" }] },
  );
  expect(JSON.parse((await invoke(undefined)).body).guidance).toEqual([]);
  expect(send.mock.calls[1][0].input).toMatchObject({
    Key: { pk: "SITE#site", sk: "ISSUE_DELETION#old-check:artifact:question" },
    ConsistentRead: true,
  });
});
