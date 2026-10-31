import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spies for the three side-effecting seams. vi.hoisted lets the mock factories
// (hoisted above imports) reference them.
const { ddbSend, sqsSend, presignPut, presignGet, headObject, setObjectTags } =
  vi.hoisted(() => ({
    ddbSend: vi.fn(),
    sqsSend: vi.fn(),
    presignPut: vi.fn(),
    presignGet: vi.fn(),
    headObject: vi.fn(),
    setObjectTags: vi.fn(),
  }));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../s3.js", () => ({
  presignPut,
  presignGet,
  headObject,
  setObjectTags,
}));
vi.mock("@aws-sdk/client-sqs", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    SQSClient: class {
      send = sqsSend;
    },
  };
});

const {
  presignUpload,
  registerArtifact,
  deleteArtifact,
  presignMedia,
  updateArtifactLocation,
} = await import("./artifacts.js");

/**
 * @param {object} opts
 * @param {string} [opts.checkId] path param
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @param {unknown} [opts.body]
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function artifactEvent({ checkId, siteClaim, body }) {
  return /** @type {any} */ ({
    pathParameters: checkId ? { checkId } : {},
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = /** @type {any} */ ({});

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const callPresign = (event) =>
  /** @type {any} */ (presignUpload(event, ctx, () => {}));

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const callRegister = (event) =>
  /** @type {any} */ (registerArtifact(event, ctx, () => {}));

beforeEach(() => {
  ddbSend.mockReset();
  sqsSend.mockReset();
  presignPut.mockReset();
  presignGet.mockReset();
  headObject.mockReset().mockResolvedValue({
    contentType: "image/jpeg",
    contentLength: 1024,
    metadata: { "declared-bytes": "1024" },
  });
  setObjectTags.mockReset().mockResolvedValue({});
  process.env.S3_UPLOAD_BUCKET = "bucket";
  process.env.SQS_QUEUE_URL = "queue";
  delete process.env.ANALYSIS_QUEUE_URL;
  process.env.DYNAMO_TABLE = "gnp-test-app";
});

describe("presignUpload", () => {
  it.each(["image/heic", "image/heif"])(
    "presigns %s for documentation while analysis registration rejects it",
    async (contentType) => {
      presignPut.mockResolvedValue("https://example.test/upload");
      const event = artifactEvent({
        checkId: "check",
        siteClaim: "site",
        body: { contentType, contentLength: 1024 },
      });
      expect((await callPresign(event)).statusCode).toBe(200);
      const result = await callRegister(
        artifactEvent({
          checkId: "check",
          siteClaim: "site",
          body: {
            artifactId: "photo",
            s3Key: "photo",
            contentType,
            contentLength: 1024,
          },
        }),
      );
      expect(result.statusCode).toBe(400);
      expect(sqsSend).not.toHaveBeenCalled();
    },
  );
  it.each([
    [10 * 1024 * 1024 + 1, "photo_too_large"],
    [0, "non_positive_content_length"],
    [-1, "non_positive_content_length"],
    [1.5, "invalid_content_length"],
    [undefined, "invalid_content_length"],
    ["private-value", "invalid_content_length"],
  ])("logs a safe reason for rejected byte count %s", async (bytes, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const event = artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          contentType: "image/jpeg",
          contentLength: bytes,
          photo: "private-photo",
          token: "private-token",
        },
      });
      event.requestContext.requestId = "gateway-request-1";
      const res = await callPresign(event);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "invalid_content_length" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0][0])).toEqual({
        level: "warn",
        marker: "UploadValidationRejected",
        requestId: "gateway-request-1",
        siteId: "site-1",
        reason,
        declaredBytes: typeof bytes === "number" ? bytes : null,
        maxBytes: 10 * 1024 * 1024,
      });
      expect(ddbSend).not.toHaveBeenCalled();
      expect(presignPut).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["missing_check_id", "invalid_json", "unsupported_content_type"])(
    "logs %s without including rejected input",
    async (reason) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const event = artifactEvent({
          checkId: reason === "missing_check_id" ? undefined : "chk_01",
          siteClaim: "site-1",
          body: { contentType: "private-value", contentLength: 123 },
        });
        if (reason === "invalid_json") event.body = "private-malformed-json";
        expect((await callPresign(event)).statusCode).toBe(400);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
          marker: "UploadValidationRejected",
          reason,
        });
        expect(warn.mock.calls[0][0]).not.toContain("private-");
        expect(presignPut).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("mints an artifactId + tenant-scoped key and presigns a PUT", async () => {
    presignPut.mockResolvedValueOnce("https://signed.example/put");

    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { contentType: "image/jpeg", contentLength: 1024 },
      }),
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.uploadUrl).toBe("https://signed.example/put");
    expect(payload.expiresIn).toBe(300);
    expect(payload.uploadHeaders).toEqual({
      "content-type": "image/jpeg",
      "if-none-match": "*",
    });
    expect(payload.uploadHeaders).not.toHaveProperty(
      "x-amz-meta-declared-bytes",
    );
    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(TransactWriteCommand);
    const reservation = ddbSend.mock.calls[0][0].input.TransactItems;
    expect(reservation).toHaveLength(4);
    expect(
      /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */ (
        reservation
      ).every(
        (op) =>
          (op.Update?.Key || op.ConditionCheck?.Key || op.Put?.Item)?.pk ===
          "SITE#site-1",
      ),
    ).toBe(true);
    expect(reservation[0].ConditionCheck.Key).toEqual({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01",
    });
    expect(reservation[1].Update.Key).toMatchObject({
      pk: "SITE#site-1",
      sk: expect.stringMatching(/^MEDIA_QUOTA#\d{4}-\d{2}-\d{2}#CHECK#chk_01$/),
    });
    expect(reservation[1].Update.Key).not.toEqual({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01",
    });
    expect(typeof payload.artifactId).toBe("string");
    expect(payload.s3Key).toBe(`checks/site-1/chk_01/${payload.artifactId}`);
    expect(payload).not.toHaveProperty("placeId");
    expect(payload).not.toHaveProperty("placeName");

    // content-type is pinned into the signature.
    expect(presignPut).toHaveBeenCalledWith({
      bucket: "bucket",
      key: payload.s3Key,
      contentType: "image/jpeg",
      contentLength: 1024,
      tagging: "state=pending",
      expiresIn: 300,
    });
  });

  it("reuses a request's original artifact without charging quota again", async () => {
    const now = Date.now();
    const existing = {
      createdBy: "device-1",
      artifactId: "original-artifact",
      s3Key: "checks/site-1/chk_01/original-artifact",
      contentType: "image/jpeg",
      contentLength: 1024,
      renewUntil: Math.floor(now / 1000) + 100,
    };
    const event = artifactEvent({
      checkId: "chk_01",
      siteClaim: "site-1",
      body: {
        contentType: "image/jpeg",
        contentLength: 1024,
        uploadRequestId: "retry-id",
      },
    });
    // Use the real principal helper's test identity rather than guessing it.
    const { deriveActorId } = await import("../lib/principal.js");
    existing.createdBy = deriveActorId(event);
    ddbSend.mockResolvedValueOnce({ Item: existing }).mockResolvedValueOnce({});
    const response = await callPresign(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      artifactId: "original-artifact",
      expiresIn: expect.any(Number),
    });
    expect(JSON.parse(response.body).expiresIn).toBeLessThanOrEqual(100);
    expect(ddbSend.mock.calls[1][0].input.TransactItems).toHaveLength(1);
    expect(ddbSend.mock.calls[1][0].input.TransactItems[0]).toHaveProperty(
      "ConditionCheck",
    );
  });

  it("raises the shared daily budget while retaining the check budget", async () => {
    ddbSend.mockResolvedValue({});
    const response = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          contentType: "image/jpeg",
          contentLength: 1024,
        },
      }),
    );
    expect(response.statusCode).toBe(200);
    const writes = ddbSend.mock.calls[0][0].input.TransactItems;
    expect(writes[1].Update.ExpressionAttributeValues).toMatchObject({
      ":maxCount": 20,
      ":remaining": 50 * 1024 * 1024 - 1024,
    });
    expect(writes[2].Update.ExpressionAttributeValues).toMatchObject({
      ":maxCount": 200,
      ":remaining": 512 * 1024 * 1024 - 1024,
    });
  });

  it("reports transaction contention as retryable conflict rather than exhausted quota", async () => {
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }],
      }),
    );
    const response = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          contentType: "image/jpeg",
          contentLength: 1024,
        },
      }),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error).toBe("upload_reservation_conflict");
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects an unsupported content-type without presigning", async () => {
    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { contentType: "application/pdf" },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("returns a non-specific 429 when any reservation budget is exhausted", async () => {
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("quota"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ],
      }),
    );
    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { contentType: "image/jpeg", contentLength: 1024 },
      }),
    );
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: "media_quota_exceeded" });
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("logs cancellation codes by operation without private error data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const codes = [
        "None",
        "ConditionalCheckFailed",
        "TransactionConflict",
        "None",
      ];
      ddbSend.mockRejectedValueOnce(
        Object.assign(new Error("private error"), {
          name: "TransactionCanceledException",
          CancellationReasons: codes.map((Code) => ({
            Code,
            Message: "private detail",
            Item: { privateField: "private value" },
          })),
        }),
      );
      await callPresign(
        artifactEvent({
          checkId: "chk_01",
          siteClaim: "site-1",
          body: { contentType: "image/jpeg", contentLength: 1024 },
        }),
      );
      const log = JSON.parse(warn.mock.calls[0][0]);
      expect(log).toEqual({
        marker: "MediaQuotaExceeded",
        siteId: "site-1",
        checkId: "chk_01",
        errorName: "TransactionCanceledException",
        cancellationReasons: [
          { operation: "check_state", code: "None" },
          { operation: "check_quota", code: "ConditionalCheckFailed" },
          { operation: "device_quota", code: "TransactionConflict" },
          { operation: "upload_reservation", code: "None" },
        ],
      });
      expect(ddbSend).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs unavailable cancellation reasons without failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ddbSend.mockRejectedValueOnce(
        Object.assign(new Error("rejected"), {
          name: "TransactionCanceledException",
        }),
      );
      await callPresign(
        artifactEvent({
          checkId: "chk_01",
          siteClaim: "site-1",
          body: { contentType: "image/jpeg", contentLength: 1024 },
        }),
      );
      expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
        errorName: "TransactionCanceledException",
        cancellationReasons: null,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores legacy placeId / placeName fields from pre-Phase-2 clients", async () => {
    // A device that has not yet picked up the flat-key client still sends the
    // retired place fields; they must not 400 and must not reach the key.
    presignPut.mockResolvedValueOnce("https://signed.example/put");

    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          placeId: "perimeter",
          placeName: "Civic Center Annex",
          contentType: "image/jpeg",
          contentLength: 1024,
        },
      }),
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.s3Key).toBe(`checks/site-1/chk_01/${payload.artifactId}`);
    expect(payload).not.toHaveProperty("placeId");
    expect(payload).not.toHaveProperty("placeName");
  });
});

describe("registerArtifact", () => {
  const validBody = {
    artifactId: "art_1",
    s3Key: "checks/site-1/chk_01/art_1",
    contentType: "image/jpeg",
    contentLength: 1024,
    capturedAt: "2026-08-14T12:00:00.000Z",
    text: "north gate clear",
  };

  it("routes foreground evidence to the dedicated analysis queue", async () => {
    process.env.ANALYSIS_QUEUE_URL = "analysis-queue";
    ddbSend.mockResolvedValueOnce({});
    sqsSend.mockResolvedValueOnce({});
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: validBody,
      }),
    );
    expect(res.statusCode).toBe(202);
    expect(sqsSend.mock.calls[0][0].input.QueueUrl).toBe("analysis-queue");
  });

  it("records the artifact with a conditional put then enqueues the S3 key only", async () => {
    ddbSend.mockResolvedValueOnce({});
    sqsSend.mockResolvedValueOnce({});

    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: validBody,
      }),
    );

    expect(res.statusCode).toBe(202);

    const put = ddbSend.mock.calls[0][0];
    expect(put).toBeInstanceOf(PutCommand);
    // Conditional write touches only this artifact's own item (no shared header
    // ConditionCheck), so a submit's parallel registrations never contend.
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(put.input.Item).toMatchObject({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01#ART#art_1",
      artifactId: "art_1",
      s3Key: "checks/site-1/chk_01/art_1",
    });
    expect(put.input.Item).not.toHaveProperty("placeId");
    expect(put.input.Item).not.toHaveProperty("placeName");

    const msg = sqsSend.mock.calls[0][0];
    expect(msg).toBeInstanceOf(SendMessageCommand);
    expect(msg.input.QueueUrl).toBe("queue");
    const body = JSON.parse(msg.input.MessageBody);
    expect(body).toEqual({
      analysisGeneration: "art_1",
      siteId: "site-1",
      checkId: "chk_01",
      artifactId: "art_1",
      s3Key: "checks/site-1/chk_01/art_1",
      capturedAt: "2026-08-14T12:00:00.000Z",
      text: "north gate clear",
    });
    // The queue must never carry media bytes.
    expect(msg.input.MessageBody).not.toMatch(/base64/i);
  });

  it("persists and enqueues valid coordinates captured with an artifact", async () => {
    ddbSend.mockResolvedValueOnce({});
    sqsSend.mockResolvedValueOnce({});

    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { ...validBody, latitude: 37.7793, longitude: -122.4192 },
      }),
    );

    expect(res.statusCode).toBe(202);
    expect(ddbSend.mock.calls[0][0].input.Item).toMatchObject({
      latitude: 37.7793,
      longitude: -122.4192,
    });
    expect(
      JSON.parse(sqsSend.mock.calls[0][0].input.MessageBody),
    ).toMatchObject({
      latitude: 37.7793,
      longitude: -122.4192,
    });
  });

  it("stores GPS accuracy with coordinates and drops an invalid one", async () => {
    ddbSend.mockResolvedValue({});
    sqsSend.mockResolvedValue({});
    const register = (/** @type {unknown} */ accuracyMeters) =>
      callRegister(
        artifactEvent({
          checkId: "chk_01",
          siteClaim: "site-1",
          body: {
            ...validBody,
            latitude: 37.7793,
            longitude: -122.4192,
            accuracyMeters,
          },
        }),
      );

    expect((await register(18)).statusCode).toBe(202);
    expect((await register(-1)).statusCode).toBe(202);
    expect(ddbSend.mock.calls[0][0].input.Item).toMatchObject({
      accuracyMeters: 18,
    });
    expect(ddbSend.mock.calls[1][0].input.Item).not.toHaveProperty(
      "accuracyMeters",
    );
  });

  it("rejects partial or out-of-range coordinates", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { ...validBody, latitude: 91 },
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_location" });
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it("rejects registration when S3 metadata differs from the signed claim", async () => {
    headObject.mockResolvedValueOnce({
      contentType: "image/png",
      contentLength: 1024,
      metadata: { "declared-bytes": "1024" },
    });
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: validBody,
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(setObjectTags).toHaveBeenCalledWith({
      bucket: "bucket",
      key: validBody.s3Key,
      tags: { state: "rejected" },
    });
    expect(ddbSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("rejects an s3Key that does not belong to this check (no writes)", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          ...validBody,
          s3Key: "checks/other-site/chk_99/art_1",
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("409s but still re-enqueues analysis when the artifact is already registered", async () => {
    // The Put and the SQS send are not atomic: a prior attempt may have persisted
    // the item then failed before enqueuing. So a replay must re-enqueue (the
    // worker's ANALYSIS# write is idempotent) or the artifact hangs waitForAnalyses
    // forever. We keep the 409 so the client still learns it was a duplicate.
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("conditional check failed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbSend.mockResolvedValueOnce({
      Item: {
        ...validBody,
        capturedAt: validBody.capturedAt,
        analysisGeneration: "art_1",
        analysisStatus: "queued",
      },
    });
    sqsSend.mockResolvedValueOnce({});

    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: validBody,
      }),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({
      error: "artifact already registered",
    });
    expect(sqsSend).toHaveBeenCalledTimes(1);
    const msg = sqsSend.mock.calls[0][0];
    expect(msg).toBeInstanceOf(SendMessageCommand);
    expect(JSON.parse(msg.input.MessageBody)).toMatchObject({
      artifactId: "art_1",
      checkId: "chk_01",
      s3Key: "checks/site-1/chk_01/art_1",
    });
  });

  it("does not re-enqueue registration replays while analysis is running", async () => {
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("exists"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbSend.mockResolvedValueOnce({
      Item: {
        ...validBody,
        analysisGeneration: "art_1",
        analysisStatus: "running",
      },
    });
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: validBody,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("queues a new generation for an explicit exhausted restart and acknowledges success", async () => {
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("exists"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    ddbSend.mockResolvedValueOnce({
      Item: {
        ...validBody,
        analysisGeneration: "art_1",
        analysisStatus: "exhausted",
      },
    });
    ddbSend.mockResolvedValueOnce({});
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          ...validBody,
          retryRequestId: "restart-1",
          expectedGeneration: "art_1",
        },
      }),
    );
    expect(res.statusCode).toBe(202);
    expect(
      JSON.parse(sqsSend.mock.calls[0][0].input.MessageBody).analysisGeneration,
    ).toBe("restart-1");
  });

  it("rejects a competing restart without queueing another generation", async () => {
    const conflict = Object.assign(new Error("exists"), {
      name: "ConditionalCheckFailedException",
    });
    ddbSend
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        Item: {
          ...validBody,
          analysisGeneration: "restart-2",
          analysisStatus: "running",
        },
      })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ Item: { analysisGeneration: "restart-2" } });
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          ...validBody,
          retryRequestId: "restart-1",
          expectedGeneration: "art_1",
        },
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("requires artifactId", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { s3Key: "checks/site-1/chk_01/x" },
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects a pre-Phase-2 key during new registration", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          artifactId: "art_1",
          placeId: "perimeter",
          placeName: "Civic Center Annex",
          s3Key: "checks/site-1/chk_01/perimeter/art_1",
          contentType: "image/jpeg",
          contentLength: 1024,
          capturedAt: "2026-08-14T12:00:00.000Z",
        },
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("accepts text-only evidence and enqueues it without an s3Key", async () => {
    ddbSend.mockResolvedValueOnce({});
    sqsSend.mockResolvedValueOnce({});

    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          artifactId: "art_text_1",
          capturedAt: "2026-08-21T15:00:00.000Z",
          text: "Graffiti is on the west wall by the entrance.",
        },
      }),
    );

    expect(res.statusCode).toBe(202);
    const put = ddbSend.mock.calls[0][0];
    expect(put.input.Item).toMatchObject({
      sk: "CHECK#chk_01#ART#art_text_1",
      text: "Graffiti is on the west wall by the entrance.",
    });
    expect(put.input.Item).not.toHaveProperty("s3Key");

    const msg = JSON.parse(sqsSend.mock.calls[0][0].input.MessageBody);
    expect(msg).toEqual({
      analysisGeneration: "art_text_1",
      siteId: "site-1",
      checkId: "chk_01",
      artifactId: "art_text_1",
      capturedAt: "2026-08-21T15:00:00.000Z",
      text: "Graffiti is on the west wall by the entrance.",
    });
  });

  it("rejects text evidence that exceeds the maximum length", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { artifactId: "art_text_2", text: "x".repeat(4001) },
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "text must be 4000 characters or fewer",
    });
    expect(ddbSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("rejects text evidence below the analyzer's 5-character minimum", async () => {
    // The Street Conditions service rejects text media under 5 chars as an
    // invalid request (permanent) — registration must refuse it instead of
    // enqueuing an artifact that can only die at the analyzer.
    for (const text of ["hi", " ok ", "abcd"]) {
      const res = await callRegister(
        artifactEvent({
          checkId: "chk_01",
          siteClaim: "site-1",
          body: { artifactId: "art_text_short", text },
        }),
      );

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: "text must be at least 5 characters",
      });
    }
    expect(ddbSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });
});

/**
 * @param {object} opts
 * @param {string} [opts.checkId] path param
 * @param {string} [opts.artifactId] path param
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function mediaEvent({ checkId, artifactId, siteClaim }) {
  return /** @type {any} */ ({
    pathParameters: {
      ...(checkId ? { checkId } : {}),
      ...(artifactId ? { artifactId } : {}),
    },
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
  });
}

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const callMedia = (event) =>
  /** @type {any} */ (presignMedia(event, ctx, () => {}));

/**
 * @param {object} opts
 * @param {string} [opts.checkId] path param
 * @param {string} [opts.artifactId] path param
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function deleteEvent({ checkId, artifactId, siteClaim }) {
  return /** @type {any} */ ({
    pathParameters: {
      ...(checkId ? { checkId } : {}),
      ...(artifactId ? { artifactId } : {}),
    },
    requestContext: siteClaim
      ? { authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } } }
      : {},
  });
}

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const callDelete = (event) =>
  /** @type {any} */ (deleteArtifact(event, ctx, () => {}));

describe("deleteArtifact", () => {
  /** A header + one artifact, as deleteArtifact's two queries read them. */
  function mockCheckWithArtifact() {
    ddbSend.mockResolvedValueOnce({
      Items: [{ sk: "CHECK#chk_01", status: "in_progress" }],
    });
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#place-north#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/place-north/art_1",
        },
      ],
    });
  }

  it("deletes the ART# item after resolving it by artifactId", async () => {
    mockCheckWithArtifact();
    ddbSend.mockResolvedValueOnce({});

    const res = await callDelete(
      deleteEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      artifactId: "art_1",
      status: "deleted",
    });
    // The header read is site-scoped and keyed to this check's header only.
    const headerQ = ddbSend.mock.calls[0][0];
    expect(headerQ.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(headerQ.input.ExpressionAttributeValues[":sk"]).toBe("CHECK#chk_01");
    expect(headerQ.input.ProjectionExpression).toBe("#status");
    expect(headerQ.input.ExpressionAttributeNames).toEqual({
      "#status": "status",
    });
    // The artifact lookup is the same ART#-prefix query presignMedia uses.
    const artQ = ddbSend.mock.calls[1][0];
    expect(artQ.input.ExpressionAttributeValues[":prefix"]).toBe(
      "CHECK#chk_01#ART#",
    );
    // The delete touches exactly the resolved ART# item.
    const del = ddbSend.mock.calls[2][0];
    expect(del).toBeInstanceOf(DeleteCommand);
    expect(del.input.Key).toEqual({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01#ART#place-north#art_1",
    });
  });

  it("404s when the check header does not exist for this site", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const res = await callDelete(
      deleteEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(404);
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  it("409s when the check is already completed (scorecard is final)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ sk: "CHECK#chk_01", status: "completed" }],
    });

    ddbSend.mockResolvedValueOnce({ Item: { status: "analyzed" } });

    const res = await callDelete(
      deleteEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(409);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("allows deleting permanently failed evidence from a completed check", async () => {
    ddbSend.mockResolvedValueOnce({ Items: [{ status: "completed" }] });
    ddbSend.mockResolvedValueOnce({
      Item: { status: "failed", retryable: false },
    });
    ddbSend.mockResolvedValueOnce({
      Items: [{ sk: "CHECK#chk_01#ART#art_1", artifactId: "art_1" }],
    });
    const response = await callDelete(
      deleteEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(ddbSend.mock.calls[1][0]).toBeInstanceOf(GetCommand);
    expect(ddbSend.mock.calls[1][0].input.ConsistentRead).toBe(true);
    expect(ddbSend.mock.calls[3][0]).toBeInstanceOf(DeleteCommand);
  });

  it("404s when no ART# item matches the artifactId (idempotent replay)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ sk: "CHECK#chk_01", status: "in_progress" }],
    });
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const res = await callDelete(
      deleteEvent({
        checkId: "chk_01",
        artifactId: "art_gone",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(404);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  it("requires checkId and artifactId", async () => {
    const noCheck = await callDelete(deleteEvent({ siteClaim: "site-1" }));
    expect(noCheck.statusCode).toBe(400);
    const noArtifact = await callDelete(
      deleteEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );
    expect(noArtifact.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("presignMedia", () => {
  it("caps the read URL at the photo's remaining 30-day retention", async () => {
    const twentyNineDaysAgo = new Date(
      Date.now() - (29 * 24 * 60 * 60 + 23 * 60 * 60) * 1000,
    ).toISOString();
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/art_1",
          receivedAt: twentyNineDaysAgo,
        },
      ],
    });
    presignGet.mockResolvedValueOnce("https://signed.example/get");

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    const { expiresIn } = presignGet.mock.calls[0][0];
    // About an hour remains; never the full TTL, never below the floor.
    expect(expiresIn).toBeGreaterThanOrEqual(60);
    expect(expiresIn).toBeLessThanOrEqual(3600);
    expect(JSON.parse(res.body).expiresIn).toBe(expiresIn);
  });

  it("keeps a short floor for a photo already past retention", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/art_1",
          receivedAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
    presignGet.mockResolvedValueOnce("https://signed.example/get");

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(presignGet.mock.calls[0][0].expiresIn).toBe(60);
  });

  it("finds a pre-Phase-2 artifact by id (retired place segment in its key) and presigns a GET", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#place-north#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/place-north/art_1",
        },
      ],
    });
    presignGet.mockResolvedValueOnce("https://signed.example/get");

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.downloadUrl).toBe("https://signed.example/get");
    expect(payload.s3Key).toBe("checks/site-1/chk_01/place-north/art_1");

    // Query is scoped to the derived site + this check's ART# prefix.
    const q = ddbSend.mock.calls[0][0];
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(q.input.ExpressionAttributeValues[":prefix"]).toBe(
      "CHECK#chk_01#ART#",
    );
    expect(presignGet).toHaveBeenCalledWith({
      bucket: "bucket",
      key: "checks/site-1/chk_01/place-north/art_1",
      expiresIn: 3600,
    });
    expect(JSON.parse(res.body).expiresIn).toBe(3600);
  });

  it("also signs the recorded card thumbnail", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/art_1",
          thumbS3Key: "checks/site-1/chk_01/art_1.thumb.webp",
        },
      ],
    });
    presignGet.mockImplementation(async ({ key }) => `https://signed/${key}`);

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.downloadUrl).toBe(
      "https://signed/checks/site-1/chk_01/art_1",
    );
    expect(payload.thumbnailUrl).toBe(
      "https://signed/checks/site-1/chk_01/art_1.thumb.webp",
    );
    expect(presignGet).toHaveBeenCalledTimes(2);
  });

  it("omits thumbnailUrl when none is recorded or the key is outside this check", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/art_1",
          thumbS3Key: "checks/site-2/chk_01/art_1.thumb.webp",
        },
      ],
    });
    presignGet.mockResolvedValueOnce("https://signed.example/get");

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.downloadUrl).toBe("https://signed.example/get");
    expect(payload).not.toHaveProperty("thumbnailUrl");
    expect(presignGet).toHaveBeenCalledTimes(1);
  });

  it("404s when no artifact matches the id (no presign)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#place-north#art_9",
          artifactId: "art_9",
          s3Key: "checks/site-1/chk_01/place-north/art_9",
        },
      ],
    });

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(404);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("refuses to sign a corrupt cross-Site media pointer", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          artifactId: "art_1",
          s3Key: "checks/site-2/chk_01/art_1",
        },
      ],
    });

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(404);
    expect(presignGet).not.toHaveBeenCalled();
  });

  it("presigns task-update media through its check-scoped pointer", async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Item: { mediaSk: "TASK#task-1#MEDIA#art_1" },
      })
      .mockResolvedValueOnce({
        Item: {
          sk: "TASK#task-1#MEDIA#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/art_1",
        },
      });

    const res = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(presignGet).toHaveBeenCalledWith({
      bucket: "bucket",
      key: "checks/site-1/chk_01/art_1",
      expiresIn: 3600,
    });
  });

  it("requires an artifactId", async () => {
    const res = await callMedia(
      mediaEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );
    expect(res.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

it.each([
  "checks/site-1/chk_01/art_1.display.jpg",
  "checks/other/chk_01/art_1.display.jpg",
])(
  "serves only the task photo's own display rendition: %s",
  async (displayS3Key) => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          entityType: "task_update_media",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/art_1",
          displayS3Key,
        },
      ],
    });
    presignGet.mockResolvedValue("https://signed.example/display");
    const response = await callMedia(
      mediaEvent({
        checkId: "chk_01",
        artifactId: "art_1",
        siteClaim: "site-1",
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(presignGet).toHaveBeenCalledWith(
      expect.objectContaining({
        key: displayS3Key.startsWith("checks/site-1/")
          ? displayS3Key
          : "checks/site-1/chk_01/art_1",
      }),
    );
  },
);

describe("updateArtifactLocation", () => {
  const location = { latitude: 37.7793, longitude: -122.4192 };

  /**
   * @param {{ body?: unknown, siteClaim?: string, artifactId?: string }} opts
   * @returns {Promise<any>}
   */
  const callLocation = ({ body, siteClaim = "site-1", artifactId = "art_1" }) =>
    /** @type {any} */ (
      updateArtifactLocation(
        /** @type {any} */ ({
          pathParameters: { checkId: "chk_01", artifactId },
          requestContext: {
            authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } },
          },
          body: JSON.stringify(body),
        }),
        ctx,
        () => {},
      )
    );

  /**
   * Answers each read the way the table would, and records every write.
   * @param {{ artifact?: Record<string, unknown>, tasks?: Record<string, unknown>[], failUpdates?: string[], failOnce?: string[], stored?: Record<string, unknown> }} state
   */
  function table({ artifact, tasks, failUpdates = [], failOnce = [], stored }) {
    /** @type {any[]} */
    const updates = [];
    const pendingFailures = new Set(failOnce);
    ddbSend.mockImplementation(async (/** @type {any} */ command) => {
      const input = command.input;
      if (command instanceof QueryCommand) {
        if (input.ExpressionAttributeValues[":prefix"] === "CHECK#chk_01#ART#")
          return { Items: artifact ? [artifact] : [] };
        return {
          Items: tasks
            ? [{ conditionId: "c1", taskIds: tasks.map((t) => t.taskId) }]
            : [],
        };
      }
      if (command instanceof GetCommand) {
        if (input.Key.sk.startsWith("GUIDANCE_CURRENT#"))
          return tasks ? { Item: { assessmentId: "asmt_1" } } : {};
        if (input.Key.sk === artifact?.sk) return { Item: stored };
        return { Item: { assessmentId: "asmt_1" } };
      }
      if (command instanceof BatchGetCommand) {
        return { Responses: { "gnp-test-app": tasks } };
      }
      if (command instanceof TransactWriteCommand) {
        const items = input.TransactItems.map(
          (/** @type {any} */ item) => item.Update,
        );
        const reasons = items.map((/** @type {any} */ u) => ({
          Code:
            failUpdates.includes(u.Key.sk) || pendingFailures.delete(u.Key.sk)
              ? "ConditionalCheckFailed"
              : "None",
        }));
        if (
          reasons.some((/** @type {{ Code: string }} */ r) => r.Code !== "None")
        ) {
          throw Object.assign(new Error("cancelled"), {
            name: "TransactionCanceledException",
            CancellationReasons: reasons,
          });
        }
        updates.push(...items);
        return {};
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    });
    return updates;
  }

  const artifact = {
    pk: "SITE#site-1",
    sk: "CHECK#chk_01#ART#art_1",
    artifactId: "art_1",
  };

  it("stores the location on the caller's own artifact", async () => {
    const updates = table({ artifact });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
      siteClaim: "site-1",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      artifactId: "art_1",
      artifactUpdated: true,
      tasksUpdated: 0,
    });
    const query = ddbSend.mock.calls[0][0];
    expect(query.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(updates[0]).toMatchObject({
      Key: { pk: "SITE#site-1", sk: "CHECK#chk_01#ART#art_1" },
      UpdateExpression:
        "SET latitude = :lat, longitude = :lng, accuracyMeters = :acc",
      ExpressionAttributeValues: {
        ":lat": 37.7793,
        ":lng": -122.4192,
        ":acc": 9,
      },
    });
  });

  it("404s for an artifact outside the caller's site or check", async () => {
    table({});
    const res = await callLocation({ body: location, siteClaim: "site-2" });
    expect(res.statusCode).toBe(404);
    expect(
      ddbSend.mock.calls[0][0].input.ExpressionAttributeValues[":pk"],
    ).toBe("SITE#site-2");
    expect(
      ddbSend.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("refuses a request without a site claim", async () => {
    table({ artifact });
    await expect(
      updateArtifactLocation(
        /** @type {any} */ ({
          pathParameters: { checkId: "chk_01", artifactId: "art_1" },
          requestContext: { authorizer: { jwt: { claims: {} } } },
          body: JSON.stringify(location),
        }),
        ctx,
        () => {},
      ),
    ).rejects.toThrow(/custom:siteId/);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ latitude: 37.7 }],
    [{ latitude: "37.7", longitude: -122.4 }],
    [{ latitude: 91, longitude: -122.4 }],
    [{ latitude: 37.7, longitude: -181 }],
    [{ latitude: 0, longitude: 0 }],
    [{ ...location, accuracyMeters: -1 }],
    [{ ...location, accuracyMeters: "9" }],
  ])(
    "rejects an invalid location %j without reading or writing",
    async (body) => {
      table({ artifact });
      const res = await callLocation({ body });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "invalid_location" });
      expect(ddbSend).not.toHaveBeenCalled();
    },
  );

  it("only replaces a stored location with a more accurate one", async () => {
    table({ artifact, failUpdates: [artifact.sk] });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 40 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).artifactUpdated).toBe(false);
    const write = ddbSend.mock.calls.find(
      ([command]) => command instanceof TransactWriteCommand,
    )?.[0];
    expect(write.input.TransactItems[0].Update.ConditionExpression).toBe(
      "attribute_exists(sk) AND (attribute_not_exists(latitude) OR attribute_not_exists(accuracyMeters) OR accuracyMeters > :acc)",
    );

    ddbSend.mockReset();
    const updates = table({ artifact });
    await callLocation({ body: location });
    // Without an accuracy, it can only fill a missing location.
    expect(updates[0].ConditionExpression).toBe(
      "attribute_exists(sk) AND attribute_not_exists(latitude)",
    );
    expect(updates[0].UpdateExpression).toBe(
      "SET latitude = :lat, longitude = :lng",
    );
  });

  it("updates tasks already written, but never one filed to 311", async () => {
    const open = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
      updatedAt: "2026-10-28T10:00:00Z",
    };
    const queued = {
      taskId: "t_queued",
      sourceArtifactIds: ["art_1"],
      status: "in_progress",
      inProgressActionKind: "311_filed",
      appActionStatus: "queued",
      source: {},
    };
    const submitted = {
      taskId: "t_submitted",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
      appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
    };
    const done = {
      taskId: "t_done",
      sourceArtifactIds: ["art_1"],
      status: "completed",
      source: {},
    };
    const updates = table({
      artifact,
      tasks: [open, queued, submitted, done],
    });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(JSON.parse(res.body)).toEqual({
      artifactId: "art_1",
      artifactUpdated: true,
      tasksUpdated: 1,
    });
    const pointer = ddbSend.mock.calls.find(
      ([command]) =>
        command instanceof GetCommand &&
        String(command.input.Key?.sk).startsWith("GUIDANCE_CURRENT#"),
    )?.[0];
    expect(pointer.input.Key).toEqual({
      pk: "SITE#site-1",
      sk: 'GUIDANCE_CURRENT#["chk_01","art_1"]',
    });
    const taskUpdates = updates.filter((u) => u.Key.sk.startsWith("TASK#"));
    expect(taskUpdates.map((u) => u.Key.sk)).toEqual(["TASK#t_open"]);
    expect(taskUpdates[0]).toMatchObject({
      UpdateExpression:
        "SET #source.#lat = :lat, #source.#lng = :lng, #source.#acc = :acc, updatedAt = :now",
      ExpressionAttributeValues: expect.objectContaining({
        ":lat": 37.7793,
        ":lng": -122.4192,
        ":acc": 9,
        ":updatedAt": "2026-10-28T10:00:00Z",
      }),
    });
    // A filing that starts between the read and this write still wins.
    expect(taskUpdates[0].ConditionExpression).toContain(
      "inProgressActionKind <> :filed",
    );
    expect(taskUpdates[0].ConditionExpression).toContain(
      "(attribute_not_exists(#source.#lat) OR attribute_not_exists(#source.#acc) OR #source.#acc > :acc)",
    );
  });

  it("keeps a task's more accurate location", async () => {
    const task = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
    };
    table({ artifact, tasks: [task], failUpdates: ["TASK#t_open"] });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      artifactUpdated: true,
      tasksUpdated: 0,
    });
  });

  it("saves the photo and its other tasks when one task was filed meanwhile", async () => {
    const filed = {
      taskId: "t_filed",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
    };
    const open = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
    };
    const updates = table({
      artifact,
      tasks: [filed, open],
      failUpdates: ["TASK#t_filed"],
    });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(JSON.parse(res.body)).toEqual({
      artifactId: "art_1",
      artifactUpdated: true,
      tasksUpdated: 1,
    });
    // Tasks read again once, then the row that still fails is dropped.
    expect(
      ddbSend.mock.calls.filter(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toHaveLength(3);
    expect(updates.map((u) => u.Key.sk)).toEqual([artifact.sk, "TASK#t_open"]);
  });

  it("reads a task again when another writer changed it meanwhile", async () => {
    const open = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
    };
    const updates = table({
      artifact,
      tasks: [open],
      failOnce: ["TASK#t_open"],
    });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(JSON.parse(res.body)).toEqual({
      artifactId: "art_1",
      artifactUpdated: true,
      tasksUpdated: 1,
    });
    expect(updates.map((u) => u.Key.sk)).toEqual([artifact.sk, "TASK#t_open"]);
  });

  it("gives the fix to a task that names no source photos", async () => {
    const updates = table({
      artifact,
      tasks: [{ taskId: "t_open", status: "open", source: {} }],
    });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(JSON.parse(res.body)).toMatchObject({ tasksUpdated: 1 });
    expect(updates.map((u) => u.Key.sk)).toEqual([artifact.sk, "TASK#t_open"]);
  });

  it("counts each task that was sent to 311 before the late location", async () => {
    const queued = {
      taskId: "t_queued",
      sourceArtifactIds: ["art_1"],
      status: "in_progress",
      inProgressActionKind: "311_filed",
      source: {},
    };
    const submitted = {
      taskId: "t_submitted",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
      appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
    };
    const open = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
    };
    table({ artifact, tasks: [queued, submitted, open] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callLocation({ body: { ...location, accuracyMeters: 9 } });
      const counted = log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("LateLocationAfterFiling"))
        .map((line) => JSON.parse(line));
      expect(
        counted.map((line) => `${line.taskId}:${line.filing}`).sort(),
      ).toEqual(["t_queued:queued", "t_submitted:submitted"]);
      expect(counted[0]).toMatchObject({
        siteId: "site-1",
        checkId: "chk_01",
        artifactId: "art_1",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("doesn't count a filed task when the photo already had a better fix", async () => {
    table({
      artifact,
      tasks: [
        {
          taskId: "t_queued",
          sourceArtifactIds: ["art_1"],
          status: "in_progress",
          inProgressActionKind: "311_filed",
          source: {},
        },
      ],
      failUpdates: [artifact.sk],
      stored: {
        ...artifact,
        latitude: 37.78,
        longitude: -122.41,
        accuracyMeters: 5,
      },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callLocation({ body: { ...location, accuracyMeters: 9 } });
      expect(
        log.mock.calls.some(([line]) =>
          String(line).includes("LateLocationAfterFiling"),
        ),
      ).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("doesn't copy a stored 0,0 placeholder onto the tasks", async () => {
    const updates = table({
      artifact,
      tasks: [
        {
          taskId: "t_open",
          sourceArtifactIds: ["art_1"],
          status: "open",
          source: {},
        },
      ],
      failUpdates: [artifact.sk],
      stored: { ...artifact, latitude: 0, longitude: 0 },
    });
    const res = await callLocation({ body: location });
    expect(JSON.parse(res.body)).toMatchObject({ tasksUpdated: 0 });
    expect(updates).toEqual([]);
  });

  it("fails on a transaction error that is not a condition check", async () => {
    table({ artifact });
    ddbSend.mockImplementationOnce(async () => ({ Items: [artifact] }));
    ddbSend.mockImplementationOnce(async () => ({}));
    ddbSend.mockImplementationOnce(async () => {
      throw Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "TransactionConflict" }],
      });
    });
    await expect(callLocation({ body: location })).rejects.toThrow("cancelled");
  });

  it("finds a photo registered moments ago with a consistent read", async () => {
    table({ artifact });
    await callLocation({ body: location });
    expect(ddbSend.mock.calls[0][0].input.ConsistentRead).toBe(true);
  });

  it("gives the tasks the photo's better stored location instead", async () => {
    const task = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: { latitude: 37.7, longitude: -122.4, accuracyMeters: 400 },
    };
    const better = {
      latitude: 37.7801,
      longitude: -122.4188,
      accuracyMeters: 8,
    };
    const updates = table({
      artifact,
      tasks: [task],
      failUpdates: [artifact.sk],
      stored: { ...artifact, ...better },
    });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 50 },
    });
    expect(JSON.parse(res.body)).toMatchObject({
      artifactUpdated: false,
      tasksUpdated: 1,
    });
    expect(updates.map((u) => u.Key.sk)).toEqual(["TASK#t_open"]);
    expect(updates[0].ExpressionAttributeValues).toMatchObject({
      ":lat": better.latitude,
      ":lng": better.longitude,
      ":acc": better.accuracyMeters,
    });
  });

  it("leaves a task sourced from another photo alone", async () => {
    const other = {
      taskId: "t_other",
      sourceArtifactIds: ["art_2"],
      status: "open",
      source: {},
    };
    const updates = table({ artifact, tasks: [other] });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(JSON.parse(res.body)).toMatchObject({ tasksUpdated: 0 });
    expect(updates.map((u) => u.Key.sk)).toEqual([artifact.sk]);
  });

  it("finds the photo on a later page of the check's artifacts", async () => {
    const updates = table({ artifact });
    const pageOne = {
      Items: [],
      LastEvaluatedKey: { sk: "CHECK#chk_01#ART#art_0" },
    };
    ddbSend.mockImplementationOnce(async () => pageOne);
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(res.statusCode).toBe(200);
    expect(updates.map((u) => u.Key.sk)).toEqual([artifact.sk]);
  });

  it("bumps a task's updatedAt so a writer holding an older copy can't overwrite the location", async () => {
    const task = {
      taskId: "t_open",
      sourceArtifactIds: ["art_1"],
      status: "open",
      source: {},
      updatedAt: "2026-10-28T10:00:00Z",
    };
    const updates = table({ artifact, tasks: [task] });
    await callLocation({ body: { ...location, accuracyMeters: 9 } });
    const taskUpdate = updates.find((u) => u.Key.sk === "TASK#t_open");
    expect(taskUpdate.UpdateExpression).toContain("updatedAt = :now");
    expect(taskUpdate.ExpressionAttributeValues[":now"]).toEqual(
      expect.any(String),
    );
    expect(taskUpdate.ExpressionAttributeValues[":now"]).not.toBe(
      "2026-10-28T10:00:00Z",
    );
  });

  it("stores a location sent before the photo's tasks exist", async () => {
    const updates = table({ artifact });
    const res = await callLocation({
      body: { ...location, accuracyMeters: 9 },
    });
    expect(JSON.parse(res.body)).toMatchObject({
      artifactUpdated: true,
      tasksUpdated: 0,
    });
    // 311 filing reads this ART# row for tasks written without a location
    // (app-actions.test.js "files 311 at a location sent after the task").
    expect(updates.map((u) => u.Key.sk)).toEqual([artifact.sk]);
  });
});
