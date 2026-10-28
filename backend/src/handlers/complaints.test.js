import { PDFDocument } from "pdf-lib";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ddbSend,
  sqsSend,
  deleteObject,
  getObjectBytes,
  headObject,
  presignGet,
  presignPut,
  setObjectTags,
} = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  sqsSend: vi.fn(),
  deleteObject: vi.fn(),
  getObjectBytes: vi.fn(),
  headObject: vi.fn(),
  presignGet: vi.fn(),
  presignPut: vi.fn(),
  setObjectTags: vi.fn(),
}));

vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../s3.js", () => ({
  deleteObject,
  getObjectBytes,
  headObject,
  presignGet,
  presignPut,
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
  createComplaint,
  deleteComplaintArtifact,
  presignComplaintArtifact,
  presignComplaintMedia,
  registerComplaintArtifact,
  retryComplaint,
} = await import("./complaints.js");

const COMPLAINT_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

/**
 * @param {{ complaintId?: string, artifactId?: string, body?: unknown }} [input]
 * @returns {any}
 */
function event({ complaintId = COMPLAINT_ID, artifactId, body } = {}) {
  return /** @type {any} */ ({
    pathParameters: { complaintId, ...(artifactId ? { artifactId } : {}) },
    requestContext: {
      authorizer: {
        jwt: { claims: { "custom:siteId": "site-1", sub: "device-1" } },
      },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  ddbSend.mockReset();
  sqsSend.mockReset();
  deleteObject.mockReset();
  getObjectBytes.mockReset();
  headObject.mockReset();
  presignGet.mockReset();
  presignPut.mockReset().mockResolvedValue("https://upload.example");
  setObjectTags.mockReset().mockResolvedValue({});
  process.env.DYNAMO_TABLE = "table";
  process.env.S3_UPLOAD_BUCKET = "bucket";
  process.env.S3_COMPLAINT_BUCKET = "complaints";
  process.env.SQS_QUEUE_URL = "queue";
});

describe("complaint upload lifecycle", () => {
  it("creates a draft and reserves complaint/device quota before presigning", async () => {
    ddbSend.mockResolvedValueOnce({});

    const response = await presignComplaintArtifact(
      event({
        body: { contentType: "image/jpeg", contentLength: 1024 },
      }),
    );

    expect(response.statusCode).toBe(200);
    const transaction = ddbSend.mock.calls[0][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(
      /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */ (
        transaction.input.TransactItems
      ).every((op) => op.Update?.Key?.pk === "SITE#site-1"),
    ).toBe(true);
    expect(transaction.input.TransactItems[0].Update).toMatchObject({
      Key: { pk: "SITE#site-1", sk: `COMPLAINT#${COMPLAINT_ID}` },
      ConditionExpression: "attribute_not_exists(pk) OR #status = :draft",
    });
    expect(transaction.input.TransactItems[1].Update.Key.sk).toMatch(
      new RegExp(`COMPLAINT#${COMPLAINT_ID}$`),
    );
    expect(presignPut).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "complaints" }),
    );
  });

  it("reuses complaint upload coordinates without charging quota again", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: {
          createdBy: "device-1",
          artifactId: ARTIFACT_ID,
          s3Key: `complaints/site-1/${COMPLAINT_ID}/${ARTIFACT_ID}`,
          contentType: "image/jpeg",
          contentLength: 1024,
          renewUntil: Math.floor(Date.now() / 1000) + 300,
        },
      })
      .mockResolvedValueOnce({});
    const response = await presignComplaintArtifact(
      event({
        body: {
          contentType: "image/jpeg",
          contentLength: 1024,
          uploadRequestId: "retry-id",
        },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).artifactId).toBe(ARTIFACT_ID);
    expect(ddbSend.mock.calls[1][0].input.TransactItems).toHaveLength(1);
  });

  it("rejects DOCX and malformed complaint IDs", async () => {
    const docx = await presignComplaintArtifact(
      event({
        body: {
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          contentLength: 1024,
        },
      }),
    );
    const malformed = await presignComplaintArtifact(
      event({
        complaintId: "A#ART#B",
        body: { contentType: "image/jpeg", contentLength: 1024 },
      }),
    );

    expect(docx.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("rejects legacy DOC and documents above the analyzer limit", async () => {
    const legacyDoc = await presignComplaintArtifact(
      event({
        body: { contentType: "application/msword", contentLength: 1024 },
      }),
    );
    const oversizedPdf = await presignComplaintArtifact(
      event({
        body: {
          contentType: "application/pdf",
          contentLength: Math.floor(4.5 * 1024 * 1024) + 1,
        },
      }),
    );

    expect(legacyDoc.statusCode).toBe(400);
    expect(oversizedPdf.statusCode).toBe(400);
    expect(presignPut).not.toHaveBeenCalled();
  });

  it("registers only while the parent complaint is a draft", async () => {
    headObject.mockResolvedValue({
      contentType: "image/jpeg",
      contentLength: 3,
    });
    getObjectBytes.mockResolvedValue({
      bytes: Buffer.from([0xff, 0xd8, 0xff]),
    });
    ddbSend.mockResolvedValueOnce({});

    const response = await registerComplaintArtifact(
      event({
        body: {
          artifactId: ARTIFACT_ID,
          s3Key: `complaints/site-1/${COMPLAINT_ID}/${ARTIFACT_ID}`,
          name: "photo.jpg",
          contentType: "image/jpeg",
          contentLength: 3,
        },
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(headObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "complaints" }),
    );
    const transaction = ddbSend.mock.calls[0][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[0].ConditionCheck).toMatchObject({
      ConditionExpression: "#status = :draft",
    });
  });

  it("uses a real PDF parser instead of accepting marker strings", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const validBytes = Buffer.from(await pdf.save());
    headObject.mockResolvedValue({
      contentType: "application/pdf",
      contentLength: validBytes.length,
    });
    getObjectBytes.mockResolvedValueOnce({ bytes: validBytes });
    ddbSend.mockResolvedValueOnce({});

    const body = {
      artifactId: ARTIFACT_ID,
      s3Key: `complaints/site-1/${COMPLAINT_ID}/${ARTIFACT_ID}`,
      name: "evidence.pdf",
      contentType: "application/pdf",
      contentLength: validBytes.length,
    };
    expect((await registerComplaintArtifact(event({ body }))).statusCode).toBe(
      201,
    );

    const fake = Buffer.from("%PDF-1.7 /Type /Page not really a PDF");
    headObject.mockResolvedValue({
      contentType: "application/pdf",
      contentLength: fake.length,
    });
    getObjectBytes.mockResolvedValueOnce({ bytes: fake });
    expect(
      (
        await registerComplaintArtifact(
          event({ body: { ...body, contentLength: fake.length } }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("allows individual artifact deletion only from a draft", async () => {
    ddbSend
      .mockResolvedValueOnce({ Item: { s3Key: "complaints/key" } })
      .mockResolvedValueOnce({});

    const response = await deleteComplaintArtifact(
      event({ artifactId: ARTIFACT_ID }),
    );

    expect(response.statusCode).toBe(200);
    expect(ddbSend.mock.calls[1][0]).toBeInstanceOf(TransactWriteCommand);
    expect(
      ddbSend.mock.calls[1][0].input.TransactItems[0].ConditionCheck
        .ConditionExpression,
    ).toBe("#status = :draft");
    expect(deleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      ddbSend.mock.invocationCallOrder[2],
    );
  });

  it("keeps a retryable deletion tombstone when S3 deletion fails", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Item: { s3Key: "complaints/key", status: "registered" },
      })
      .mockResolvedValueOnce({});
    deleteObject.mockRejectedValueOnce(new Error("S3 unavailable"));

    await expect(
      deleteComplaintArtifact(event({ artifactId: ARTIFACT_ID })),
    ).rejects.toThrow("S3 unavailable");

    expect(ddbSend).toHaveBeenCalledTimes(2);
    expect(
      ddbSend.mock.calls[1][0].input.TransactItems[1].Update
        .ExpressionAttributeValues[":deleting"],
    ).toBe("deleting");
  });
});

describe("complaint scheduling", () => {
  it("keeps the complaint as a draft when evidence retagging fails", async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        {
          pk: "SITE#site-1",
          sk: `COMPLAINT#${COMPLAINT_ID}#ART#${ARTIFACT_ID}`,
          s3Key: "complaints/key",
          contentLength: 1024,
          status: "registered",
        },
      ],
    });
    setObjectTags.mockRejectedValueOnce(new Error("S3 unavailable"));

    await expect(
      createComplaint(
        event({ body: { complaintId: COMPLAINT_ID, description: "Noise" } }),
      ),
    ).rejects.toThrow("S3 unavailable");

    expect(ddbSend).toHaveBeenCalledTimes(1);
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it("publishes the complaint and artifact retention atomically", async () => {
    ddbSend
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: `COMPLAINT#${COMPLAINT_ID}#ART#${ARTIFACT_ID}`,
            s3Key: "complaints/key",
            contentLength: 1024,
            status: "registered",
          },
        ],
      })
      .mockResolvedValueOnce({});
    sqsSend.mockResolvedValueOnce({});

    const response = await createComplaint(
      event({ body: { complaintId: COMPLAINT_ID, description: "Noise" } }),
    );

    expect(response.statusCode).toBe(202);
    const transaction = ddbSend.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems[0].Update).toBeDefined();
    expect(transaction.input.TransactItems[1].Update.Key.sk).toContain(
      ARTIFACT_ID,
    );
    expect(sqsSend).toHaveBeenCalledTimes(1);
  });

  it("returns the persisted complaint without enqueueing a duplicate submission", async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(
        Object.assign(new Error("duplicate"), {
          name: "ConditionalCheckFailedException",
        }),
      )
      .mockResolvedValueOnce({
        Item: { complaintId: COMPLAINT_ID, status: "analyzing" },
      });

    const response = await createComplaint(
      event({ body: { complaintId: COMPLAINT_ID, description: "Noise" } }),
    );

    expect(response.statusCode).toBe(202);
    expect(sqsSend).not.toHaveBeenCalled();
    expect(ddbSend.mock.calls[2][0]).toBeInstanceOf(GetCommand);
    expect(ddbSend.mock.calls[2][0].input.ConsistentRead).toBe(true);
  });

  it("restores retryability when retry enqueueing fails", async () => {
    ddbSend.mockResolvedValue({});
    sqsSend.mockRejectedValueOnce(new Error("SQS unavailable"));

    await expect(retryComplaint(event())).rejects.toThrow("SQS unavailable");

    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
    const rollback = ddbSend.mock.calls[1][0];
    expect(rollback).toBeInstanceOf(UpdateCommand);
    expect(rollback.input.ConditionExpression).toContain("analysisAttemptId");
    expect(rollback.input.ExpressionAttributeValues[":failed"]).toBe(
      "analysis_failed",
    );
  });

  it("requires a live parent complaint before issuing a media URL", async () => {
    ddbSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { s3Key: "complaints/key" } });

    const response = await presignComplaintMedia(
      event({ artifactId: ARTIFACT_ID }),
    );

    expect(response.statusCode).toBe(404);
    expect(presignGet).not.toHaveBeenCalled();
  });
});
