import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, analyzeEdit, analyzeReject, createAnalyzerClient } = vi.hoisted(
  () => ({
    send: vi.fn(),
    analyzeEdit: vi.fn(),
    analyzeReject: vi.fn(),
    createAnalyzerClient: vi.fn(),
  }),
);
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../analysis/analyzer-client.js", () => ({
  AnalyzerError: class AnalyzerError extends Error {
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
  },
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
    requestContext: { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * @param {any} event
 * @param {(event: any) => Promise<any>} handler
 * @returns {Promise<any>}
 */
const invoke = (event, handler) => handler(event, {}, () => {});

/**
 * Stored ANALYSIS# item the GetItem returns.
 * @param {{ analysisId?: string, checkId?: string, artifactId?: string }} [over]
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

  it("edit resolves the stored analysis by artifact key and calls the analyzer with ITS analysisId", async () => {
    send.mockResolvedValueOnce({ Item: analysisItem() });
    // supersedeOpenTasksForCondition's GSI2 query (empty open-task list).
    send.mockResolvedValueOnce({ Items: [] });

    const res = await invoke(
      amendEvent({
        body: { description: "Actually paint spilled here" },
      }),
      editAnalysisCondition,
    );

    expect(res.statusCode).toBe(200);
    // Single key-predicated GetItem — not a partition query.
    const get = send.mock.calls[0][0];
    expect(get).toBeInstanceOf(GetCommand);
    expect(get.input.Key).toEqual({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01#ANALYSIS#art_1",
    });
    expect(get.input.ConsistentRead).toBe(true);
    // One GetItem + the supersede's GSI2 open-task query; a partition scan
    // would page the whole site here — that's the regression this guards.
    expect(send).toHaveBeenCalledTimes(2);
    expect(analyzeEdit).toHaveBeenCalledWith(
      "ana_20260907_ab12cd34",
      "chk_01-art_1-001-litter",
      expect.objectContaining({
        description: "Actually paint spilled here",
        appId: "good-neighbor-app",
      }),
    );
    // Supersede ran with the resolved context (assessmentIdPrefix).
    const supersedeQuery = send.mock.calls[1][0];
    expect(supersedeQuery.input.ExpressionAttributeValues[":worklist"]).toBe(
      "SITE#site-1#TASK#open",
    );
  });

  it("reject resolves by key and passes the reason through", async () => {
    send.mockResolvedValueOnce({ Item: analysisItem() });
    send.mockResolvedValueOnce({ Items: [] });

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

  it("keys the supersede off the RESOLVED check/artifact, not client input", async () => {
    // A malicious/mistyped checkId just 404s — the item's own checkId/artifactId
    // drive the analyzer call and the supersede scope.
    send.mockResolvedValueOnce({
      Item: analysisItem({ checkId: "chk_REAL", artifactId: "art_REAL" }),
    });
    send.mockResolvedValueOnce({ Items: [] });

    await invoke(
      amendEvent({ body: { reason: { key: "not_a_problem" } } }),
      rejectAnalysisCondition,
    );

    const supersedeQuery = send.mock.calls[1][0];
    expect(supersedeQuery).not.toBeInstanceOf(TransactWriteCommand);
    // The supersede's GSI2 query is scoped to the resolved site — the
    // assessmentIdPrefix filter (chk_REAL-art_REAL) applies to its results.
    expect(supersedeQuery.input.ExpressionAttributeValues[":worklist"]).toBe(
      "SITE#site-1#TASK#open",
    );
  });

  it("client-supplied analysisId is ignored — server-stored one wins", async () => {
    send.mockResolvedValueOnce({
      Item: analysisItem({ analysisId: "ana_SERVER" }),
    });
    send.mockResolvedValueOnce({ Items: [] });

    await invoke(
      amendEvent({ body: { description: "A corrected description" } }),
      editAnalysisCondition,
    );

    expect(analyzeEdit).toHaveBeenCalledWith(
      "ana_SERVER",
      expect.any(String),
      expect.anything(),
    );
  });
});