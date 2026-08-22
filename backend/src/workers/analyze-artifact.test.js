import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { singleLowConcernResponse } from "../analysis/fixtures/single-low-concern.js";

// Spies for every side-effecting seam. The analyzer client is mocked to hand
// back a controllable `analyze` spy; AnalyzerError is kept from the real module
// (spread) so instanceof checks in the worker still work.
const { ddbSend, getObjectBytes, analyze, createAnalyzerClient } = vi.hoisted(
  () => ({
    ddbSend: vi.fn(),
    getObjectBytes: vi.fn(),
    analyze: vi.fn(),
    createAnalyzerClient: vi.fn(),
  }),
);
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../s3.js", () => ({ getObjectBytes }));
vi.mock("../analysis/analyzer-client.js", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, createAnalyzerClient };
});

const { AnalyzerError } = await import("../analysis/analyzer-client.js");
const { handler } = await import("./analyze-artifact.js");

const baseMsg = {
  siteId: "site-1",
  checkId: "chk_01",
  artifactId: "art_1",
  s3Key: "checks/site-1/chk_01/north/art_1",
  side: "north",
  capturedAt: "2026-08-14T12:00:00.000Z",
  text: "north gate clear",
};

/**
 * @param {object} msg
 * @returns {Promise<any>}
 */
const invoke = (msg) =>
  /** @type {any} */ (
    handler(
      /** @type {any} */ ({
        Records: [{ messageId: "m1", body: JSON.stringify(msg) }],
      }),
      /** @type {any} */ ({}),
      () => {},
    )
  );

beforeEach(() => {
  ddbSend.mockReset();
  getObjectBytes.mockReset();
  analyze.mockReset();
  createAnalyzerClient.mockReset();
  createAnalyzerClient.mockReturnValue({ analyze });
  process.env.S3_UPLOAD_BUCKET = "bucket";
  process.env.SQS_QUEUE_URL = "queue";
  process.env.DYNAMO_TABLE = "gnp-test-app";
  process.env.ANALYZER_BASE_URL = "https://analyzer.example/";
  process.env.ANALYZER_API_KEY = "test-key";
});

describe("analyze-artifact worker", () => {
  it("analyzes a photo, stores the ANALYSIS#, and bumps header counters", async () => {
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("img-bytes"),
      contentType: "image/jpeg",
    });
    analyze.mockResolvedValueOnce(singleLowConcernResponse);
    ddbSend.mockResolvedValue({});

    await invoke(baseMsg);

    // Media is fetched by S3 key — never carried on the message.
    expect(getObjectBytes).toHaveBeenCalledWith({
      bucket: "bucket",
      key: "checks/site-1/chk_01/north/art_1",
    });

    // The analyzer gets per-photo metadata + image (and text) media, keyed for
    // tracing as checkId#artifactId.
    expect(analyze).toHaveBeenCalledTimes(1);
    const call = analyze.mock.calls[0][0];
    expect(call.metadata).toEqual({
      position_descriptor: "north",
      reported_at: "2026-08-14T12:00:00.000Z",
      latitude: 0,
      longitude: 0,
    });
    expect(call.requestId).toBe("chk_01#art_1");
    expect(call.media[0]).toEqual({
      type: "image",
      content_type: "image/jpeg",
      base64: Buffer.from("img-bytes").toString("base64"),
    });
    expect(call.media[1]).toEqual({ type: "text", text: "north gate clear" });

    // ANALYSIS# written conditionally with the adapted per-artifact scorecard.
    const put = ddbSend.mock.calls[0][0];
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(put.input.Item).toMatchObject({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01#ANALYSIS#art_1",
      status: "analyzed",
      grade: "Fair",
      issueCount: 1,
      maxSeverity: 2,
    });

    // Running counters: +1 issue, then raise maxSeverity to this photo's 2.
    const inc = ddbSend.mock.calls[1][0];
    expect(inc).toBeInstanceOf(UpdateCommand);
    expect(inc.input.Key).toEqual({ pk: "SITE#site-1", sk: "CHECK#chk_01" });
    expect(inc.input.UpdateExpression).toBe("ADD issueCount :inc");
    expect(inc.input.ExpressionAttributeValues[":inc"]).toBe(1);

    const max = ddbSend.mock.calls[2][0];
    expect(max.input.UpdateExpression).toBe("SET maxSeverity = :sev");
    expect(max.input.ConditionExpression).toBe(
      "attribute_exists(sk) AND maxSeverity < :sev",
    );
    expect(max.input.ExpressionAttributeValues[":sev"]).toBe(2);

    expect(ddbSend).toHaveBeenCalledTimes(3);
  });

  it("is idempotent: a redelivered message writes no second analysis or counter", async () => {
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("img"),
      contentType: "image/jpeg",
    });
    analyze.mockResolvedValueOnce(singleLowConcernResponse);
    // The conditional ANALYSIS# put fails: the item already exists.
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("exists"), {
        name: "ConditionalCheckFailedException",
      }),
    );

    await invoke(baseMsg);

    // Only the ANALYSIS# put was attempted; no counter updates followed it.
    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(PutCommand);
  });

  it("reports a retryable analyzer error as a batch item failure so SQS redelivers just that message", async () => {
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("img"),
      contentType: "image/jpeg",
    });
    analyze.mockRejectedValueOnce(
      new AnalyzerError("throttled", { status: 429, retryable: true }),
    );

    // A rejected artifact no longer throws the whole batch — it comes back in
    // batchItemFailures so only that message redelivers.
    const res = await invoke(baseMsg);
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("analyzes a batch concurrently and isolates one failure to its own message", async () => {
    // Two photos in one batch: art_1 succeeds, art_2's analyzer call rejects.
    getObjectBytes.mockResolvedValue({
      bytes: Buffer.from("img"),
      contentType: "image/jpeg",
    });
    analyze
      .mockResolvedValueOnce(singleLowConcernResponse) // art_1
      .mockRejectedValueOnce(
        new AnalyzerError("throttled", { status: 429, retryable: true }),
      ); // art_2
    ddbSend.mockResolvedValue({});

    const res = await /** @type {any} */ (
      handler(
        /** @type {any} */ ({
          Records: [
            { messageId: "m1", body: JSON.stringify(baseMsg) },
            {
              messageId: "m2",
              body: JSON.stringify({ ...baseMsg, artifactId: "art_2" }),
            },
          ],
        }),
        /** @type {any} */ ({}),
        () => {},
      )
    );

    // Both fired (concurrently); only the failed one redelivers.
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
  });

  it("marks a permanent analyzer failure and consumes the message", async () => {
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("img"),
      contentType: "image/jpeg",
    });
    analyze.mockRejectedValueOnce(
      new AnalyzerError("bad request", {
        status: 400,
        code: "invalid_request",
        retryable: false,
      }),
    );
    ddbSend.mockResolvedValue({});

    await invoke(baseMsg);

    // A single failure marker, conditional so a replay can't duplicate it.
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const put = ddbSend.mock.calls[0][0];
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(put.input.Item).toMatchObject({
      sk: "CHECK#chk_01#ANALYSIS#art_1",
      status: "failed",
      error: { code: "invalid_request", status: 400, message: "bad request" },
    });
  });

  it("marks an unsupported media type as failed without calling the analyzer", async () => {
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("%PDF"),
      contentType: "application/pdf",
    });
    ddbSend.mockResolvedValue({});

    await invoke(baseMsg);

    expect(analyze).not.toHaveBeenCalled();
    const put = ddbSend.mock.calls[0][0];
    expect(put.input.Item).toMatchObject({
      status: "failed",
      error: { code: "unsupported_input_type" },
    });
  });

  it("throws when ANALYZER_BASE_URL is not configured", async () => {
    delete process.env.ANALYZER_BASE_URL;
    await expect(invoke(baseMsg)).rejects.toThrow(/ANALYZER_BASE_URL/);
    expect(getObjectBytes).not.toHaveBeenCalled();
  });
});
