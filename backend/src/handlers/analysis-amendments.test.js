import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  send,
  analyzeEdit,
  analyzeReject,
  createAnalyzerClient,
  AnalyzerError,
} = vi.hoisted(() => {
  class AnalyzerError extends Error {
    /**
     * @param {string} message
     * @param {{ code?: string, status?: number, details?: unknown }} [opts]
     */
    constructor(message, opts = {}) {
      super(message);
      this.code = opts.code;
      this.status = opts.status;
      this.details = opts.details;
    }
  }
  return {
    send: vi.fn(),
    analyzeEdit: vi.fn(),
    analyzeReject: vi.fn(),
    createAnalyzerClient: vi.fn(),
    AnalyzerError,
  };
});
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../analysis/analyzer-client.js", () => ({
  AnalyzerError,
  createAnalyzerClient,
}));

const { editAnalysisCondition, rejectAnalysisCondition } = await import(
  "./analysis-amendments.js"
);

/**
 * @param {object} opts
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @param {string} [opts.checkId]
 * @param {string} [opts.artifactId]
 * @param {string} [opts.conditionId]
 * @param {unknown} [opts.body]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function amendEvent({
  siteClaim = "site-1",
  checkId = "chk_01",
  artifactId = "art_1",
  conditionId = "chk_01-art_1-001-litter",
  body,
}) {
  return /** @type {any} */ ({
    pathParameters: { checkId, artifactId, conditionId },
    requestContext: {
      authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Invoke a handler the way the Lambda runtime would.
 * @param {any} event
 * @param {(event: any, ...rest: any[]) => Promise<any>} handler
 * @returns {Promise<any>} the handler's proxy result
 */
const invoke = (event, handler) => handler(event, {}, () => {});

/**
 * Stored ANALYSIS# item the GetItem returns.
 * @param {{ analysisId?: string, checkId?: string, artifactId?: string }} [over]
 * @returns {{ checkId: string, artifactId: string, analysisId: string }}
 */
const analysisItem = (over = {}) => ({
  checkId: "chk_01",
  artifactId: "art_1",
  analysisId: "ana_20260907_ab12cd34",
  ...over,
});

describe("analysis amendments (check/artifact-addressed)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    send.mockReset();
    analyzeEdit.mockReset();
    analyzeReject.mockReset();
    createAnalyzerClient.mockReset();
    process.env.ANALYZER_API_KEY = "test-key";
    process.env.ANALYZER_BASE_URL = "https://analyzer.example.test";
    process.env.DYNAMO_TABLE = "gnp-test-app";
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    createAnalyzerClient.mockResolvedValue({
      editCondition: analyzeEdit,
      rejectCondition: analyzeReject,
    });
    analyzeEdit.mockResolvedValue({
      analysis_id: "ana_1",
      condition: {},
      assessment: {},
    });
    analyzeReject.mockResolvedValue({
      analysis_id: "ana_1",
      rejected_condition_id: "c1",
      assessment: {},
    });
  });

  it("saves a correction without calling the analyzer or changing guidance", async () => {
    send.mockResolvedValueOnce({ Item: { assessmentId: "assessment" } });
    send.mockResolvedValueOnce({ Item: { assessmentRevision: 4 } });
    send.mockResolvedValueOnce({
      Item: {
        conditionId: "condition",
        description: "Old description",
        taskIds: ["task"],
      },
    });
    send.mockResolvedValueOnce({
      Item: {
        pk: "SITE#site-1",
        sk: "TASK#task",
        taskId: "task",
        status: "open",
        description: "Old description",
        appActions: [],
      },
    });
    send.mockResolvedValueOnce({});
    const res = await editAnalysisCondition(
      amendEvent({
        body: { description: "Corrected description", language: "vi" },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(createAnalyzerClient).not.toHaveBeenCalled();
    const tx = send.mock.calls.at(-1)?.[0].input.TransactItems;
    expect(tx).toHaveLength(3);
    expect(tx[0].Update.ExpressionAttributeValues).toEqual({
      ":prior": 4,
      ":next": 5,
    });
    expect(tx[1].Update.ExpressionAttributeValues[":text"]).toBe(
      "Corrected description",
    );
    expect(tx[2].Update.Key.sk).toBe("TASK#task");
    expect(JSON.stringify(tx)).not.toContain("SF311_JOB");
  });

  it("rejects a superseded assessment instead of reviving its description", async () => {
    send.mockResolvedValueOnce({ Item: { assessmentId: "assessment" } });
    send.mockResolvedValueOnce({ Item: { supersededByAssessmentId: "next" } });
    send.mockResolvedValueOnce({ Item: { description: "Old description" } });
    const res = await editAnalysisCondition(
      amendEvent({ body: { description: "Corrected description" } }),
    );
    expect(res.statusCode).toBe(409);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("returns a conflict when a concurrent answer wins the assessment revision", async () => {
    send.mockResolvedValueOnce({ Item: { assessmentId: "assessment" } });
    send.mockResolvedValueOnce({ Item: { assessmentRevision: 4 } });
    send.mockResolvedValueOnce({ Item: { taskIds: [] } });
    send.mockRejectedValueOnce(
      Object.assign(new Error("changed"), {
        name: "TransactionCanceledException",
      }),
    );
    const res = await editAnalysisCondition(
      amendEvent({ body: { description: "Corrected description" } }),
    );
    expect(res.statusCode).toBe(409);
    expect(createAnalyzerClient).not.toHaveBeenCalled();
  });

  it("reject resolves by key, passes the reason through, and retires its open task", async () => {
    send.mockResolvedValueOnce({ Item: analysisItem() });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({
      Items: [
        {
          pk: "SITE#site-1",
          sk: "TASK#task-1",
          taskId: "task-1",
          status: "open",
          kind: "escalation",
          severity: 3,
          conditionId: "chk_01-art_1-001-litter",
          checkId: "chk_01",
          assessmentId: "chk_01-art_1",
        },
      ],
    });
    send.mockResolvedValueOnce({});

    const res = await invoke(
      amendEvent({
        body: { reason: { key: "not_a_problem" } },
      }),
      rejectAnalysisCondition,
    );

    expect(res.statusCode).toBe(200);
    expect(analyzeReject).toHaveBeenCalledWith(
      "ana_20260907_ab12cd34",
      "chk_01-art_1-001-litter",
      expect.objectContaining({ reason: { key: "not_a_problem" } }),
    );
    const query = send.mock.calls[4][0];
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ":worklist": "SITE#site-1#TASK#open",
      ":conditionId": "chk_01-art_1-001-litter",
    });
    const transaction = send.mock.calls[5][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
      taskId: "task-1",
      status: "superseded",
      supersededByAnalysisId: "ana_20260907_ab12cd34",
      supersessionReason: "analysis_condition_rejected",
      gsi2pk: "SITE#site-1#TASK#superseded",
    });
  });

  it("keeps an unknown-condition rejection retryable until durably confirmed", async () => {
    analyzeReject.mockRejectedValueOnce(
      new AnalyzerError("Unknown condition", {
        code: "unknown_condition",
        status: 404,
      }),
    );
    send.mockResolvedValueOnce({ Item: analysisItem() });
    send.mockResolvedValueOnce({});
    send.mockResolvedValueOnce({});
    const res = await invoke(amendEvent({}), rejectAnalysisCondition);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("RejectionUnconfirmed");
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("retires a just-published task through strongly consistent primary-key reads", async () => {
    const task = {
      pk: "SITE#site-1",
      sk: "TASK#task-fresh",
      taskId: "task-fresh",
      status: "open",
      kind: "escalation",
      severity: 3,
      conditionId: "chk_01-art_1-001-litter",
      checkId: "chk_01",
      assessmentId: "chk_01-art_1",
    };
    send
      .mockResolvedValueOnce({ Item: analysisItem() })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: task })
      .mockResolvedValueOnce({
        Item: {
          conditionId: "chk_01-art_1-001-litter",
          checkId: "chk_01",
          taskIds: ["task-fresh"],
        },
      })
      .mockResolvedValueOnce({ Responses: { "gnp-test-app": [task] } })
      .mockResolvedValueOnce({});

    const res = await invoke(
      amendEvent({
        body: {
          reason: { key: "not_a_problem" },
          taskId: "task-fresh",
        },
      }),
      rejectAnalysisCondition,
    );

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[4][0]).toMatchObject({
      input: {
        Key: { pk: "SITE#site-1", sk: "TASK#task-fresh" },
        ConsistentRead: true,
      },
    });
    expect(send.mock.calls[5][0]).toMatchObject({
      input: {
        Key: {
          pk: "SITE#site-1",
          sk: "ASSESSMENT#chk_01-art_1#COND#chk_01-art_1-001-litter",
        },
        ConsistentRead: true,
      },
    });
    expect(send.mock.calls[6][0]).toBeInstanceOf(BatchGetCommand);
    expect(send.mock.calls[7][0]).toBeInstanceOf(TransactWriteCommand);
    expect(send.mock.calls[7][0].input.TransactItems[0].Put.Item).toMatchObject(
      { taskId: "task-fresh", status: "superseded" },
    );
  });

  it("preserves confirmed category and upstream time across a failed cleanup and next-day retry", async () => {
    /** @type {any} */ let receipt;
    let failCleanup = true;
    let failConfirmation = true;
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key?.sk.includes("#ANALYSIS#")) {
          expect(command.input.ProjectionExpression).toContain("concerns");
          return {
            Item: {
              ...analysisItem(),
              concerns: [
                { conditionId: "chk_01-art_1-001-litter", category: "Litter" },
              ],
            },
          };
        }
        return { Item: receipt };
      }
      if (command instanceof PutCommand) {
        if (command.input.Item?.deletedAt && failConfirmation) {
          failConfirmation = false;
          throw new Error("transient confirmation failure");
        }
        receipt = command.input.Item;
        return {};
      }
      if (failCleanup) {
        failCleanup = false;
        throw new Error("cleanup failed");
      }
      return { Items: [] };
    });
    analyzeReject.mockResolvedValue({
      rejection: { created_at: "2026-10-23T15:00:00Z" },
    });
    await expect(
      invoke(amendEvent({}), rejectAnalysisCondition),
    ).rejects.toThrow("cleanup failed");
    expect(receipt).toMatchObject({
      state: "confirmed",
      category: "Litter",
      deletedAt: "2026-10-23T15:00:00.000Z",
    });
    await invoke(amendEvent({}), rejectAnalysisCondition);
    expect(analyzeReject).toHaveBeenCalledTimes(1);
    expect(receipt.deletedAt).toBe("2026-10-23T15:00:00.000Z");
  });

  it("retains an ambiguous attempt without inventing a deletion after confirmation write failure", async () => {
    /** @type {any} */ let receipt;
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item: command.input.Key?.sk.includes("#ANALYSIS#")
            ? analysisItem()
            : receipt,
        };
      if (command instanceof PutCommand) {
        if (command.input.Item?.deletedAt)
          throw new Error("confirmation write failed");
        receipt = command.input.Item;
      }
      return { Items: [] };
    });
    await expect(
      invoke(amendEvent({}), rejectAnalysisCondition),
    ).rejects.toThrow("confirmation write failed");
    const attemptedAt = receipt.attemptedAt;
    analyzeReject.mockRejectedValue(
      new AnalyzerError("Unknown condition", {
        status: 404,
        code: "unknown_condition",
      }),
    );
    await invoke(amendEvent({}), rejectAnalysisCondition);
    expect(receipt).toMatchObject({ state: "pending", attemptedAt });
    expect(receipt).not.toHaveProperty("deletedAt");
  });

  it("404s when the artifact has no ANALYSIS# item (not yet analyzed)", async () => {
    send.mockResolvedValueOnce({});

    const res = await invoke(
      amendEvent({ body: { description: "Something descriptive" } }),
      editAnalysisCondition,
    );

    expect(res.statusCode).toBe(404);
    expect(analyzeEdit).not.toHaveBeenCalled();
  });

  it("404s when the item is a failed marker (no analysisId attribute)", async () => {
    send.mockResolvedValueOnce({
      Item: { checkId: "chk_01", artifactId: "art_1", status: "failed" },
    });

    const res = await invoke(
      amendEvent({ body: { reason: { key: "other" } } }),
      rejectAnalysisCondition,
    );

    expect(res.statusCode).toBe(404);
    expect(analyzeReject).not.toHaveBeenCalled();
  });

  it("400s on missing path params", async () => {
    const res = await invoke(
      amendEvent({ checkId: "", body: { description: "long enough" } }),
      editAnalysisCondition,
    );
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("400s when description is below 5 or above the 4000-char cap", async () => {
    const tooShort = await invoke(
      amendEvent({ body: { description: "hi" } }),
      editAnalysisCondition,
    );
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await invoke(
      amendEvent({ body: { description: "x".repeat(4001) } }),
      editAnalysisCondition,
    );
    expect(tooLong.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("400s when reason.note exceeds 1000 chars", async () => {
    const res = await invoke(
      amendEvent({
        body: { reason: { key: "other", note: "x".repeat(1001) } },
      }),
      rejectAnalysisCondition,
    );
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "dismisses expired analyzer results only for a verified site-owned condition: %s",
    async (verified) => {
      /** @type {any} */ let receipt;
      analyzeReject.mockRejectedValue(
        new AnalyzerError("Expired", { status: 404, code: "unknown_analysis" }),
      );
      send.mockImplementation(async (command) => {
        if (command instanceof GetCommand)
          return {
            Item: command.input.Key?.sk.includes("#ANALYSIS#")
              ? {
                  ...analysisItem(),
                  concerns: verified
                    ? [
                        {
                          conditionId: "chk_01-art_1-001-litter",
                          category: "Litter",
                        },
                      ]
                    : [],
                }
              : receipt,
          };
        if (command instanceof PutCommand) receipt = command.input.Item;
        return { Items: [] };
      });
      const response = await invoke(amendEvent({}), rejectAnalysisCondition);
      expect(response.statusCode).toBe(verified ? 200 : 404);
      if (verified) {
        expect(JSON.parse(response.body)).toMatchObject({
          dismissed_locally: true,
        });
        expect(receipt).toMatchObject({
          state: "dismissed",
          dismissalReason: "analysis_unavailable",
          pk: "SITE#site-1",
        });
        expect(receipt.dismissedAt).toBeTruthy();
        expect(receipt).not.toHaveProperty("deletedAt");
        const { statusRecords } = await import("../domain/system-status.js");
        expect(statusRecords(receipt)).toEqual([]);
        await invoke(amendEvent({}), rejectAnalysisCondition);
        expect(analyzeReject).toHaveBeenCalledOnce();
      } else {
        expect(receipt.state).toBe("pending");
        expect(receipt).not.toHaveProperty("dismissedAt");
      }
    },
  );
  it("does not report a historical dismissal as saved when its durable write fails", async () => {
    /** @type {any} */ let receipt;
    analyzeReject.mockRejectedValue(
      new AnalyzerError("Expired", { status: 404, code: "unknown_analysis" }),
    );
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item: command.input.Key?.sk.includes("#ANALYSIS#")
            ? {
                ...analysisItem(),
                concerns: [
                  {
                    conditionId: "chk_01-art_1-001-litter",
                    category: "Litter",
                  },
                ],
              }
            : receipt,
        };
      if (command instanceof PutCommand) {
        if (command.input.Item?.dismissedAt)
          throw new Error("dismissal write failed");
        receipt = command.input.Item;
      }
      return { Items: [] };
    });
    await expect(
      invoke(amendEvent({}), rejectAnalysisCondition),
    ).rejects.toThrow("dismissal write failed");
    expect(receipt.state).toBe("pending");
    expect(receipt).not.toHaveProperty("dismissedAt");
    expect(analyzeReject).toHaveBeenCalledOnce();
  });
});
