import { presignGet } from "../s3.js";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ddbSend, extractComplaint } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  extractComplaint: vi.fn(),
}));

vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../analysis/analyzer-client.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createAnalyzerClient: () => ({ extractComplaint }),
}));
vi.mock("../analysis/api-key.js", () => ({
  getAnalyzerApiKey: vi.fn().mockResolvedValue("key"),
}));
vi.mock("../s3.js", () => ({
  getObjectBytes: vi.fn(),
  presignGet: vi.fn(),
}));

const { handler } = await import("./analyze-complaint.js");
const { AnalyzerError } = await import("../analysis/analyzer-client.js");

function event({ attempt = "attempt-1", receiveCount = 1 } = {}) {
  return {
    Records: [
      {
        body: JSON.stringify({
          type: "analyze_complaint",
          siteId: "site-1",
          complaintId: "complaint-1",
          analysisAttemptId: attempt,
        }),
        attributes: { ApproximateReceiveCount: String(receiveCount) },
      },
    ],
  };
}

beforeEach(() => {
  ddbSend.mockReset();
  extractComplaint.mockReset();
  process.env.DYNAMO_TABLE = "table";
  process.env.S3_UPLOAD_BUCKET = "bucket";
  process.env.S3_COMPLAINT_BUCKET = "complaints";
  process.env.SQS_QUEUE_URL = "queue";
  process.env.ANALYZER_BASE_URL = "https://analyzer.example";
  process.env.ANALYZER_API_KEY_SECRET_ARN = "secret";
});

describe("complaint analysis attempt fencing", () => {
  it("acknowledges a stale queued attempt without calling the analyzer", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: { status: "analyzing", analysisAttemptId: "newer-attempt" },
      })
      .mockResolvedValueOnce({ Items: [] });

    await handler(event({ attempt: "stale-attempt" }));

    expect(extractComplaint).not.toHaveBeenCalled();
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("conditions a terminal failure on the active attempt", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          status: "analyzing",
          analysisAttemptId: "attempt-1",
          description: "Persistent noise",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    extractComplaint.mockRejectedValueOnce(new Error("analyzer unavailable"));

    await handler(event({ receiveCount: 5 }));

    const failure = ddbSend.mock.calls[2][0];
    expect(failure).toBeInstanceOf(UpdateCommand);
    expect(failure.input.ConditionExpression).toBe(
      "#status = :analyzing AND analysisAttemptId = :attempt",
    );
    expect(failure.input.ExpressionAttributeValues[":attempt"]).toBe(
      "attempt-1",
    );
  });

  it("acknowledges a conditional failure from a late successful worker", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          status: "analyzing",
          analysisAttemptId: "attempt-1",
          description: "Persistent noise",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error("stale"), {
          name: "ConditionalCheckFailedException",
        }),
      );
    extractComplaint.mockResolvedValueOnce({
      complaint: {
        label: "Noise complaint",
        detail: "Noise was reported.",
        what: "Noise",
        where: "Outside",
        when: "Today",
        notes: "",
      },
    });

    await expect(handler(event())).resolves.toBeUndefined();
  });
});

describe("complaint permanent analyzer failures", () => {
  /** @param {Error} error */
  function prepareFailure(error) {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          status: "analyzing",
          analysisAttemptId: "attempt-1",
          description: "Noise",
        },
      })
      .mockResolvedValueOnce({ Items: [] });
    extractComplaint.mockRejectedValueOnce(error);
  }

  it.each(["model_unavailable", "model_access_denied"])(
    "records %s on the first delivery and acknowledges it",
    async (code) => {
      prepareFailure(
        new AnalyzerError("Contact the service operator", {
          status: 502,
          code,
          retryable: false,
        }),
      );
      ddbSend.mockResolvedValueOnce({});
      await expect(handler(event())).resolves.toBeUndefined();
      expect(extractComplaint).toHaveBeenCalledTimes(1);
      expect(ddbSend).toHaveBeenCalledTimes(3);
      const update = ddbSend.mock.calls[2][0].input;
      expect(update.ExpressionAttributeValues[":failed"]).toBe(
        "analysis_failed",
      );
      expect(update.ExpressionAttributeValues[":attempt"]).toBe("attempt-1");
      expect(update.ConditionExpression).toBe(
        "#status = :analyzing AND analysisAttemptId = :attempt",
      );
    },
  );

  it.each([
    new AnalyzerError("Throttled", { status: 429, retryable: true }),
    new AnalyzerError("Unavailable", { status: 502, retryable: true }),
    new Error("Unknown failure"),
  ])(
    "preserves redelivery for transient or unknown failures",
    async (error) => {
      prepareFailure(error);
      await expect(handler(event())).rejects.toBe(error);
      expect(ddbSend).toHaveBeenCalledTimes(2);
    },
  );

  it("retries if recording a permanent failure fails", async () => {
    prepareFailure(
      new AnalyzerError("Retired", { status: 502, retryable: false }),
    );
    const storageError = new Error("DynamoDB unavailable");
    ddbSend.mockRejectedValueOnce(storageError);
    await expect(handler(event())).rejects.toBe(storageError);
  });

  it("acknowledges a permanent failure for an attempt superseded during analysis", async () => {
    prepareFailure(
      new AnalyzerError("Retired", { status: 502, retryable: false }),
    );
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("Superseded"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    await expect(handler(event())).resolves.toBeUndefined();
  });
});

it("regenerates evidence URLs on redelivery after a retrieval failure", async () => {
  const error = new AnalyzerError("Try again", {
    status: 422,
    code: "evidence_retrieval_failed",
    retryable: true,
  });
  vi.mocked(presignGet)
    .mockReset()
    .mockResolvedValueOnce("https://local/first")
    .mockResolvedValueOnce("https://local/fresh");
  extractComplaint.mockRejectedValue(error);
  for (const receiveCount of [1, 2]) {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          status: "analyzing",
          analysisAttemptId: "attempt-1",
          description: "Noise",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            name: "evidence.pdf",
            contentType: "application/pdf",
            s3Key: "evidence",
          },
        ],
      });
    await expect(handler(event({ receiveCount }))).rejects.toBe(error);
  }
  expect(presignGet).toHaveBeenCalledTimes(2);
  expect(extractComplaint.mock.calls[0][0].files[0].source_url).toBe(
    "https://local/first",
  );
  expect(extractComplaint.mock.calls[1][0].files[0].source_url).toBe(
    "https://local/fresh",
  );
  expect(
    ddbSend.mock.calls.every(
      ([command]) => !(command instanceof UpdateCommand),
    ),
  ).toBe(true);
});

describe("optional complaint extraction fields", () => {
  /** @param {Record<string, unknown>} complaint */
  function prepare(complaint) {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          status: "analyzing",
          analysisAttemptId: "attempt-1",
          description: "Noise",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValue({});
    extractComplaint.mockResolvedValueOnce({ complaint });
  }
  it.each([{}, { what: "", where: "", when: "", notes: "" }])(
    "stores a ready complaint with optional fields %j",
    async (optional) => {
      prepare({
        label: "Noise complaint",
        detail: "Noise was reported.",
        ...optional,
      });
      await handler(event());
      const update = ddbSend.mock.calls[2][0].input;
      expect(update.ExpressionAttributeValues).toMatchObject({
        ":ready": "ready",
        ":label": "Noise complaint",
        ":detail": "Noise was reported.",
        ":what": "",
        ":where": "",
        ":when": "",
        ":notes": "",
        ":attempt": "attempt-1",
      });
      expect(update.Key).toEqual({
        pk: "SITE#site-1",
        sk: "COMPLAINT#complaint-1",
      });
      expect(update.ConditionExpression).toContain(
        "analysisAttemptId = :attempt",
      );
    },
  );
  it.each([{ label: "" }, { detail: "" }, { notes: [] }, { what: 123 }])(
    "still rejects invalid substantive fields or types %j",
    async (invalid) => {
      prepare({
        label: "Noise complaint",
        detail: "Noise was reported.",
        ...invalid,
      });
      await expect(handler(event())).rejects.toThrow(/invalid complaint/);
      expect(ddbSend).toHaveBeenCalledTimes(2);
    },
  );
});
