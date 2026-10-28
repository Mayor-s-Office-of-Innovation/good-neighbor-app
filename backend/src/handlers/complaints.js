// @ts-nocheck -- handler boundary validates untyped API Gateway JSON at runtime.
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { PDFDocument } from "pdf-lib";
import { ddb } from "../db.js";
import { getComplaintBucket, getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import {
  deleteObject,
  getObjectBytes,
  headObject,
  presignGet,
  presignPut,
  setObjectTags,
} from "../s3.js";
import {
  complaintArtifactKey,
  complaintArtifactPrefix,
  complaintKey,
  complaintTimelineGsi,
  GSI1_NAME,
  sitePk,
} from "./keys.js";
import {
  MAX_DEVICE_DAILY_ARTIFACTS,
  MAX_DEVICE_DAILY_BYTES,
  quotaUpdate,
} from "./artifacts.js";

import {
  reserveUpload,
  reservationStatus,
  uploadUrlLifetime,
} from "./upload-reservations.js";

const sqs = new SQSClient({});
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = Math.floor(4.5 * 1024 * 1024);
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5;
const MAX_TEXT = 4000;
const TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/plain",
]);
const isDocument = (type) =>
  type === "application/pdf" || type === "text/plain";
const maxBytesFor = (type) =>
  isDocument(type) ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mediaKey = (siteId, complaintId, artifactId) =>
  `complaints/${siteId}/${complaintId}/${artifactId}`;

const params = (event) => ({
  complaintId: event.pathParameters?.complaintId,
  artifactId: event.pathParameters?.artifactId,
});

const withoutFields = (value, omitted) =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.includes(key)),
  );

const validSignature = async (bytes, type) => {
  const hex = bytes.subarray(0, 12).toString("hex");
  if (type === "image/jpeg") return hex.startsWith("ffd8ff");
  if (type === "image/png") return hex.startsWith("89504e470d0a1a0a");
  if (type === "image/webp")
    return (
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    );
  if (type === "image/heic" || type === "image/heif") {
    const brands = bytes.subarray(4, 32).toString("latin1");
    return /ftyp(?:heic|heix|hevc|hevx|mif1|msf1)/.test(brands);
  }
  if (type === "application/pdf") {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return false;
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      updateMetadata: false,
    });
    const pages = document.getPageCount();
    return pages > 0 && pages <= 10;
  }
  if (type === "text/plain")
    return (
      !bytes.includes(0) &&
      new TextDecoder("utf-8", { fatal: true }).decode(bytes).length > 0
    );
  return false;
};

export async function presignComplaintArtifact(event) {
  const siteId = deriveSiteId(event);
  const { complaintId } = params(event);
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  if (
    !UUID.test(complaintId || "") ||
    typeof body?.contentType !== "string" ||
    !TYPES.has(body.contentType)
  )
    return jsonResponse(400, { error: "unsupported_media_type" });
  if (
    !Number.isInteger(body.contentLength) ||
    body.contentLength <= 0 ||
    body.contentLength > maxBytesFor(body.contentType)
  )
    return jsonResponse(400, { error: "invalid_content_length" });
  let artifactId = randomUUID();
  let s3Key = mediaKey(siteId, complaintId, artifactId);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const expiresAt = Math.floor(now.getTime() / 1000) + 86400;
  const bytes = Number(body.contentLength);
  const tableName = getConfig().dynamoTable;
  let uploadExpiresIn = 300;
  try {
    const writes = [
      {
        Update: {
          TableName: tableName,
          Key: complaintKey(siteId, complaintId),
          UpdateExpression:
            "SET #type = if_not_exists(#type, :type), complaintId = if_not_exists(complaintId, :complaintId), #status = if_not_exists(#status, :draft), createdAt = if_not_exists(createdAt, :now), createdBy = if_not_exists(createdBy, :actor), expiresAt = :expiresAt",
          ConditionExpression: "attribute_not_exists(pk) OR #status = :draft",
          ExpressionAttributeNames: {
            "#type": "type",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":type": "complaint",
            ":complaintId": complaintId,
            ":draft": "draft",
            ":now": now.toISOString(),
            ":actor": deriveActorId(event),
            ":expiresAt": expiresAt,
          },
        },
      },
      quotaUpdate({
        tableName,
        key: {
          pk: sitePk(siteId),
          sk: `MEDIA_QUOTA#${day}#COMPLAINT#${complaintId}`,
        },
        bytes,
        maxBytes: MAX_TOTAL_BYTES,
        countField: "reservedCount",
        maxCount: MAX_FILES,
        expiresAt,
      }),
      quotaUpdate({
        tableName,
        key: {
          pk: sitePk(siteId),
          sk: `MEDIA_QUOTA#${day}#DEVICE#${deriveActorId(event)}`,
        },
        bytes,
        maxBytes: MAX_DEVICE_DAILY_BYTES,
        countField: "reservedCount",
        maxCount: MAX_DEVICE_DAILY_ARTIFACTS,
        expiresAt,
      }),
    ];
    const reservation = await reserveUpload({
      requestId: body.uploadRequestId,
      tableName,
      writes,
      reservation: {
        pk: sitePk(siteId),
        kind: "complaint",
        parentId: complaintId,
        createdBy: deriveActorId(event),
        artifactId,
        s3Key,
        contentType: body.contentType,
        contentLength: bytes,
        createdAt: now.toISOString(),
      },
      parentGuard: {
        ConditionCheck: {
          TableName: tableName,
          Key: complaintKey(siteId, complaintId),
          ConditionExpression: "attribute_exists(pk) AND #status = :draft",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":draft": "draft" },
        },
      },
    });
    ({ artifactId, s3Key } = reservation);
    uploadExpiresIn = uploadUrlLifetime(reservation);
  } catch (error) {
    const status = reservationStatus(error);
    if (status) return jsonResponse(status, { error: error.code });
    if (
      error?.name === "TransactionCanceledException" ||
      error?.name === "ConditionalCheckFailedException"
    ) {
      const quotaFailed = [1, 2].some(
        (index) =>
          error.CancellationReasons?.[index]?.Code === "ConditionalCheckFailed",
      );
      return quotaFailed
        ? jsonResponse(429, { error: "media_quota_exceeded" })
        : jsonResponse(409, { error: "upload_reservation_conflict" });
    }
    throw error;
  }
  const uploadUrl = await presignPut({
    bucket: getComplaintBucket(),
    key: s3Key,
    contentType: body.contentType,
    contentLength: body.contentLength,
    tagging: "state=pending",
    expiresIn: uploadExpiresIn,
  });
  return jsonResponse(200, {
    artifactId,
    s3Key,
    uploadUrl,
    uploadHeaders: { "content-type": body.contentType, "if-none-match": "*" },
    expiresIn: uploadExpiresIn,
  });
}

export async function registerComplaintArtifact(event) {
  const siteId = deriveSiteId(event);
  const { complaintId } = params(event);
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const expected = mediaKey(siteId, complaintId, body?.artifactId);
  if (
    !UUID.test(complaintId || "") ||
    !UUID.test(body?.artifactId || "") ||
    body?.s3Key !== expected ||
    !TYPES.has(body?.contentType) ||
    typeof body?.name !== "string"
  )
    return jsonResponse(400, { error: "invalid_artifact" });
  const head = await headObject({
    bucket: getComplaintBucket(),
    key: expected,
  });
  if (
    head.contentType !== body.contentType ||
    head.contentLength !== body.contentLength ||
    head.contentLength > maxBytesFor(body.contentType)
  )
    return jsonResponse(400, { error: "media_mismatch" });
  const object = await getObjectBytes({
    bucket: getComplaintBucket(),
    key: expected,
  });
  let signatureValid = false;
  try {
    signatureValid = await validSignature(object.bytes, body.contentType);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return jsonResponse(400, { error: "invalid_media" });
  const item = {
    ...complaintArtifactKey(siteId, complaintId, body.artifactId),
    type: "complaintArtifact",
    complaintId,
    artifactId: body.artifactId,
    s3Key: expected,
    name: body.name.slice(0, 255),
    contentType: body.contentType,
    contentLength: body.contentLength,
    status: "registered",
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getConfig().dynamoTable,
              Key: complaintKey(siteId, complaintId),
              ConditionExpression: "#status = :draft",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":draft": "draft" },
            },
          },
          {
            Put: {
              TableName: getConfig().dynamoTable,
              Item: item,
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      error?.name === "TransactionCanceledException" ||
      error?.name === "ConditionalCheckFailedException"
    )
      return jsonResponse(409, { error: "complaint_not_mutable" });
    throw error;
  }
  return jsonResponse(201, {
    artifactId: body.artifactId,
    status: "registered",
  });
}

const readArtifacts = async (siteId, complaintId) =>
  (
    await ddb.send(
      new QueryCommand({
        TableName: getConfig().dynamoTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": sitePk(siteId),
          ":prefix": complaintArtifactPrefix(complaintId),
        },
      }),
    )
  ).Items || [];

export async function createComplaint(event) {
  const siteId = deriveSiteId(event);
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const complaintId = body?.complaintId;
  const description =
    typeof body?.description === "string" ? body.description.trim() : "";
  if (!UUID.test(complaintId || "") || description.length > MAX_TEXT)
    return jsonResponse(400, { error: "invalid_complaint" });
  const artifacts = await readArtifacts(siteId, complaintId);
  if (!description && !artifacts.length)
    return jsonResponse(400, { error: "complaint_content_required" });
  if (
    artifacts.length > MAX_FILES ||
    artifacts.reduce((n, a) => n + (a.contentLength || 0), 0) >
      MAX_TOTAL_BYTES ||
    artifacts.some(
      (artifact) =>
        artifact.status !== undefined && artifact.status !== "registered",
    )
  )
    return jsonResponse(400, { error: "complaint_media_limit" });
  const createdAt = new Date().toISOString();
  const analysisAttemptId = randomUUID();
  const item = {
    ...complaintKey(siteId, complaintId),
    ...complaintTimelineGsi(siteId, createdAt, complaintId),
    type: "complaint",
    complaintId,
    createdAt,
    createdBy: deriveActorId(event),
    status: "analyzing",
    label: "New complaint - analyzing",
    description,
    artifactCount: artifacts.length,
    analysisAttemptId,
    expiresAt: Math.floor(Date.now() / 1000) + 365 * 86400,
  };
  const retentionExpiresAt = Math.floor(Date.now() / 1000) + 365 * 86400;
  // Keep the header a draft until every external S3 mutation succeeds. The
  // following transaction then publishes the header and extends every row's
  // retention atomically, so no pre-enqueue failure can strand `analyzing`.
  await Promise.all(
    artifacts.map((artifact) =>
      setObjectTags({
        bucket: getComplaintBucket(),
        key: artifact.s3Key,
        tags: { state: "complaint" },
      }),
    ),
  );
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: getConfig().dynamoTable,
              Key: complaintKey(siteId, complaintId),
              UpdateExpression:
                "SET gsi1pk = :gsi1pk, gsi1sk = :gsi1sk, #type = :type, complaintId = :complaintId, createdAt = if_not_exists(createdAt, :createdAt), createdBy = if_not_exists(createdBy, :createdBy), #status = :analyzing, label = :label, description = :description, artifactCount = :artifactCount, analysisAttemptId = :attempt, expiresAt = :expiresAt",
              ConditionExpression:
                "attribute_not_exists(pk) OR #status = :draft",
              ExpressionAttributeNames: {
                "#type": "type",
                "#status": "status",
              },
              ExpressionAttributeValues: {
                ":gsi1pk": item.gsi1pk,
                ":gsi1sk": item.gsi1sk,
                ":type": item.type,
                ":complaintId": complaintId,
                ":createdAt": createdAt,
                ":createdBy": item.createdBy,
                ":draft": "draft",
                ":analyzing": "analyzing",
                ":label": item.label,
                ":description": description,
                ":artifactCount": artifacts.length,
                ":attempt": analysisAttemptId,
                ":expiresAt": item.expiresAt,
              },
            },
          },
          ...artifacts.map((artifact) => ({
            Update: {
              TableName: getConfig().dynamoTable,
              Key: { pk: artifact.pk, sk: artifact.sk },
              UpdateExpression: "SET expiresAt = :expiresAt",
              ConditionExpression:
                "attribute_exists(sk) AND (attribute_not_exists(#status) OR #status = :registered)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":expiresAt": retentionExpiresAt,
                ":registered": "registered",
              },
            },
          })),
        ],
      }),
    );
  } catch (error) {
    if (
      error?.name !== "TransactionCanceledException" &&
      error?.name !== "ConditionalCheckFailedException"
    )
      throw error;
    const existing = await ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
        ConsistentRead: true,
      }),
    );
    if (!existing.Item || existing.Item.status === "draft") throw error;
    return jsonResponse(202, { complaint: existing.Item });
  }
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: getConfig().queueUrl,
        MessageBody: JSON.stringify({
          type: "analyze_complaint",
          siteId,
          complaintId,
          analysisAttemptId,
        }),
      }),
    );
  } catch (error) {
    await ddb.send(
      new UpdateCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
        UpdateExpression: "SET #status = :failed, label = :label",
        ConditionExpression:
          "#status = :analyzing AND analysisAttemptId = :attempt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":failed": "analysis_failed",
          ":analyzing": "analyzing",
          ":label": "Complaint log failed",
          ":attempt": analysisAttemptId,
        },
      }),
    );
    throw error;
  }
  return jsonResponse(202, { complaint: item });
}

export async function listComplaints(event) {
  const siteId = deriveSiteId(event);
  const out = await ddb.send(
    new QueryCommand({
      TableName: getConfig().dynamoTable,
      IndexName: GSI1_NAME,
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `${sitePk(siteId)}#COMPLAINTS` },
      ScanIndexForward: false,
    }),
  );
  return jsonResponse(200, {
    complaints: (out.Items || []).map((item) =>
      withoutFields(item, ["description", "gsi1pk", "gsi1sk", "pk", "sk"]),
    ),
  });
}

export async function getComplaint(event) {
  const siteId = deriveSiteId(event);
  const { complaintId } = params(event);
  if (!UUID.test(complaintId || ""))
    return jsonResponse(400, { error: "invalid_complaint" });
  const [header, artifacts] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
      }),
    ),
    readArtifacts(siteId, complaintId),
  ]);
  if (!header.Item) return jsonResponse(404, { error: "complaint_not_found" });
  return jsonResponse(200, {
    complaint: header.Item,
    artifacts: artifacts.map((item) =>
      withoutFields(item, ["s3Key", "pk", "sk"]),
    ),
  });
}

export async function retryComplaint(event) {
  const siteId = deriveSiteId(event);
  const { complaintId } = params(event);
  if (!UUID.test(complaintId || ""))
    return jsonResponse(400, { error: "invalid_complaint" });
  const analysisAttemptId = randomUUID();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
        UpdateExpression:
          "SET #status = :analyzing, label = :label, analysisAttemptId = :attempt",
        ConditionExpression: "#status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":analyzing": "analyzing",
          ":failed": "analysis_failed",
          ":label": "New complaint - analyzing",
          ":attempt": analysisAttemptId,
        },
      }),
    );
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException")
      return jsonResponse(409, { error: "complaint_not_retryable" });
    throw error;
  }
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: getConfig().queueUrl,
        MessageBody: JSON.stringify({
          type: "analyze_complaint",
          siteId,
          complaintId,
          analysisAttemptId,
        }),
      }),
    );
  } catch (error) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: complaintKey(siteId, complaintId),
          UpdateExpression: "SET #status = :failed, label = :label",
          ConditionExpression:
            "#status = :analyzing AND analysisAttemptId = :attempt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":failed": "analysis_failed",
            ":analyzing": "analyzing",
            ":label": "Complaint log failed",
            ":attempt": analysisAttemptId,
          },
        }),
      );
    } catch (rollbackError) {
      if (rollbackError?.name !== "ConditionalCheckFailedException")
        throw rollbackError;
    }
    throw error;
  }
  return jsonResponse(202, { status: "analyzing" });
}

export async function deleteComplaint(event) {
  const siteId = deriveSiteId(event);
  const { complaintId } = params(event);
  if (!UUID.test(complaintId || ""))
    return jsonResponse(400, { error: "invalid_complaint" });
  const header = await ddb.send(
    new GetCommand({
      TableName: getConfig().dynamoTable,
      Key: complaintKey(siteId, complaintId),
    }),
  );
  if (!header.Item) return jsonResponse(404, { error: "complaint_not_found" });
  if (header.Item.status === "analyzing")
    return jsonResponse(409, { error: "complaint_analyzing" });
  if (header.Item.status !== "deleting") {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: complaintKey(siteId, complaintId),
          UpdateExpression: "SET #status = :deleting",
          ConditionExpression: "#status IN (:ready, :failed)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":deleting": "deleting",
            ":ready": "ready",
            ":failed": "analysis_failed",
          },
        }),
      );
    } catch (error) {
      if (error?.name === "ConditionalCheckFailedException")
        return jsonResponse(409, { error: "complaint_not_deletable" });
      throw error;
    }
  }
  const artifacts = await readArtifacts(siteId, complaintId);
  await Promise.all(
    artifacts.map((a) =>
      deleteObject({ bucket: getComplaintBucket(), key: a.s3Key }),
    ),
  );
  await Promise.all([
    ...artifacts.map((a) =>
      ddb.send(
        new DeleteCommand({
          TableName: getConfig().dynamoTable,
          Key: { pk: a.pk, sk: a.sk },
        }),
      ),
    ),
    ddb.send(
      new DeleteCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
        ConditionExpression: "#status = :deleting",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":deleting": "deleting" },
      }),
    ),
  ]);
  return jsonResponse(200, { status: "deleted" });
}

export async function deleteComplaintArtifact(event) {
  const siteId = deriveSiteId(event);
  const { complaintId, artifactId } = params(event);
  if (!UUID.test(complaintId || "") || !UUID.test(artifactId || ""))
    return jsonResponse(400, { error: "invalid_artifact" });
  const key = complaintArtifactKey(siteId, complaintId, artifactId);
  const item = await ddb.send(
    new GetCommand({ TableName: getConfig().dynamoTable, Key: key }),
  );
  if (!item.Item) return jsonResponse(404, { error: "artifact_not_found" });
  if (item.Item.status !== "deleting") {
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: getConfig().dynamoTable,
                Key: complaintKey(siteId, complaintId),
                ConditionExpression: "#status = :draft",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":draft": "draft" },
              },
            },
            {
              Update: {
                TableName: getConfig().dynamoTable,
                Key: key,
                UpdateExpression: "SET #status = :deleting",
                ConditionExpression:
                  "attribute_exists(sk) AND (attribute_not_exists(#status) OR #status = :registered)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":registered": "registered",
                  ":deleting": "deleting",
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        error?.name === "TransactionCanceledException" ||
        error?.name === "ConditionalCheckFailedException"
      )
        return jsonResponse(409, { error: "complaint_not_mutable" });
      throw error;
    }
  }
  await deleteObject({
    bucket: getComplaintBucket(),
    key: item.Item.s3Key,
  });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: getConfig().dynamoTable,
              Key: complaintKey(siteId, complaintId),
              ConditionExpression: "#status = :draft",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":draft": "draft" },
            },
          },
          {
            Delete: {
              TableName: getConfig().dynamoTable,
              Key: key,
              ConditionExpression: "#status = :deleting",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":deleting": "deleting" },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      error?.name === "TransactionCanceledException" ||
      error?.name === "ConditionalCheckFailedException"
    )
      return jsonResponse(409, { error: "complaint_not_mutable" });
    throw error;
  }
  return jsonResponse(200, { status: "deleted" });
}

export async function presignComplaintMedia(event) {
  const siteId = deriveSiteId(event);
  const { complaintId, artifactId } = params(event);
  if (!UUID.test(complaintId || "") || !UUID.test(artifactId || ""))
    return jsonResponse(400, { error: "invalid_artifact" });
  const [header, item] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintArtifactKey(siteId, complaintId, artifactId),
      }),
    ),
  ]);
  if (!header.Item || header.Item.status === "deleting")
    return jsonResponse(404, { error: "complaint_not_found" });
  if (!item.Item) return jsonResponse(404, { error: "artifact_not_found" });
  return jsonResponse(200, {
    downloadUrl: await presignGet({
      bucket: getComplaintBucket(),
      key: item.Item.s3Key,
      expiresIn: 300,
    }),
    expiresIn: 300,
  });
}
