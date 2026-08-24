import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spies for the three side-effecting seams. vi.hoisted lets the mock factories
// (hoisted above imports) reference them.
const { ddbSend, sqsSend, presignPut, presignGet } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  sqsSend: vi.fn(),
  presignPut: vi.fn(),
  presignGet: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../s3.js", () => ({ presignPut, presignGet }));
vi.mock("@aws-sdk/client-sqs", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    SQSClient: class {
      send = sqsSend;
    },
  };
});

const { presignUpload, registerArtifact, presignMedia } = await import(
  "./artifacts.js"
);

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
  process.env.S3_UPLOAD_BUCKET = "bucket";
  process.env.SQS_QUEUE_URL = "queue";
  process.env.DYNAMO_TABLE = "gnp-test-app";
});

describe("presignUpload", () => {
  it("mints an artifactId + tenant-scoped key and presigns a PUT", async () => {
    presignPut.mockResolvedValueOnce("https://signed.example/put");

    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { side: "north", contentType: "image/jpeg" },
      }),
    );

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.uploadUrl).toBe("https://signed.example/put");
    expect(payload.expiresIn).toBe(300);
    expect(typeof payload.artifactId).toBe("string");
    expect(payload.s3Key).toBe(
      `checks/site-1/chk_01/north/${payload.artifactId}`,
    );

    // content-type is pinned into the signature.
    expect(presignPut).toHaveBeenCalledWith({
      bucket: "bucket",
      key: payload.s3Key,
      contentType: "image/jpeg",
      expiresIn: 300,
    });
  });

  it("rejects an unsupported content-type without presigning", async () => {
    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { side: "north", contentType: "application/pdf" },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("requires a side", async () => {
    const res = await callPresign(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { contentType: "image/jpeg" },
      }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("registerArtifact", () => {
  const validBody = {
    artifactId: "art_1",
    side: "north",
    s3Key: "checks/site-1/chk_01/north/art_1",
    contentType: "image/jpeg",
    capturedAt: "2026-08-14T12:00:00.000Z",
    text: "north gate clear",
  };

  it("transactionally records the artifact then enqueues the S3 key only", async () => {
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

    const tx = ddbSend.mock.calls[0][0];
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    const [check, put] = tx.input.TransactItems;
    // Parent must exist — no grafting onto a missing/foreign check.
    expect(check.ConditionCheck.Key).toEqual({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01",
    });
    expect(check.ConditionCheck.ConditionExpression).toBe(
      "attribute_exists(sk)",
    );
    // Artifact write is conditional (no duplicate).
    expect(put.Put.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(put.Put.Item).toMatchObject({
      pk: "SITE#site-1",
      sk: "CHECK#chk_01#ART#north#art_1",
      artifactId: "art_1",
      s3Key: "checks/site-1/chk_01/north/art_1",
    });

    const msg = sqsSend.mock.calls[0][0];
    expect(msg).toBeInstanceOf(SendMessageCommand);
    const body = JSON.parse(msg.input.MessageBody);
    expect(body).toEqual({
      siteId: "site-1",
      checkId: "chk_01",
      artifactId: "art_1",
      s3Key: "checks/site-1/chk_01/north/art_1",
      side: "north",
      capturedAt: "2026-08-14T12:00:00.000Z",
      text: "north gate clear",
    });
    // The queue must never carry media bytes.
    expect(msg.input.MessageBody).not.toMatch(/base64/i);
  });

  it("rejects an s3Key that does not belong to this check (no writes)", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: { ...validBody, s3Key: "checks/other-site/chk_99/north/art_1" },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("409s and does not enqueue when the transaction is cancelled", async () => {
    ddbSend.mockRejectedValueOnce(
      Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
      }),
    );

    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: validBody,
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
        body: { side: "north", s3Key: "checks/site-1/chk_01/north/x" },
      }),
    );
    expect(res.statusCode).toBe(400);
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
          side: "west",
          capturedAt: "2026-08-21T15:00:00.000Z",
          text: "Graffiti is on the west wall by the entrance.",
        },
      }),
    );

    expect(res.statusCode).toBe(202);
    const tx = ddbSend.mock.calls[0][0];
    expect(tx.input.TransactItems[1].Put.Item).toMatchObject({
      sk: "CHECK#chk_01#ART#west#art_text_1",
      text: "Graffiti is on the west wall by the entrance.",
    });
    expect(tx.input.TransactItems[1].Put.Item).not.toHaveProperty("s3Key");

    const msg = JSON.parse(sqsSend.mock.calls[0][0].input.MessageBody);
    expect(msg).toEqual({
      siteId: "site-1",
      checkId: "chk_01",
      artifactId: "art_text_1",
      side: "west",
      capturedAt: "2026-08-21T15:00:00.000Z",
      text: "Graffiti is on the west wall by the entrance.",
    });
  });

  it("rejects text evidence that exceeds the maximum length", async () => {
    const res = await callRegister(
      artifactEvent({
        checkId: "chk_01",
        siteClaim: "site-1",
        body: {
          artifactId: "art_text_2",
          side: "west",
          text: "x".repeat(4001),
        },
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "text must be 4000 characters or fewer",
    });
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

describe("presignMedia", () => {
  it("finds the artifact by id (side is in its key) and presigns a GET", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#north#art_1",
          artifactId: "art_1",
          s3Key: "checks/site-1/chk_01/north/art_1",
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
    expect(payload.s3Key).toBe("checks/site-1/chk_01/north/art_1");

    // Query is scoped to the derived site + this check's ART# prefix.
    const q = ddbSend.mock.calls[0][0];
    expect(q.input.ExpressionAttributeValues[":pk"]).toBe("SITE#site-1");
    expect(q.input.ExpressionAttributeValues[":prefix"]).toBe(
      "CHECK#chk_01#ART#",
    );
    expect(presignGet).toHaveBeenCalledWith({
      bucket: "bucket",
      key: "checks/site-1/chk_01/north/art_1",
      expiresIn: 300,
    });
  });

  it("404s when no artifact matches the id (no presign)", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          sk: "CHECK#chk_01#ART#north#art_9",
          artifactId: "art_9",
          s3Key: "checks/site-1/chk_01/north/art_9",
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

  it("requires an artifactId", async () => {
    const res = await callMedia(
      mediaEvent({ checkId: "chk_01", siteClaim: "site-1" }),
    );
    expect(res.statusCode).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});
