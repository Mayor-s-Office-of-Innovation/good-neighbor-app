// @ts-nocheck -- handler boundary validates untyped API Gateway JSON at runtime.
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
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

const sqs = new SQSClient({});
const MAX_FILE_BYTES = 10 * 1024 * 1024;
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
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

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

const safeDocx = (bytes) => {
  const directory = bytes.toString("latin1");
  if (
    !directory.includes("[Content_Types].xml") ||
    !directory.includes("word/document.xml")
  )
    return false;
  return !/(vbaProject\.bin|externalLinks\/|embeddings\/)/i.test(directory);
};

const validSignature = (bytes, type) => {
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
    const source = bytes.toString("latin1");
    const pages = source.match(/\/Type\s*\/Page\b/g)?.length || 0;
    return (
      source.startsWith("%PDF-") &&
      pages > 0 &&
      pages <= 10 &&
      !/\/Encrypt\b/.test(source)
    );
  }
  if (type === "text/plain")
    return (
      !bytes.includes(0) &&
      new TextDecoder("utf-8", { fatal: true }).decode(bytes).length > 0
    );
  if (type === "application/msword") return hex.startsWith("d0cf11e0a1b11ae1");
  if (type.includes("officedocument"))
    return hex.startsWith("504b0304") && safeDocx(bytes);
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
    !complaintId ||
    typeof body?.contentType !== "string" ||
    !TYPES.has(body.contentType)
  )
    return jsonResponse(400, { error: "unsupported_media_type" });
  if (
    !Number.isInteger(body.contentLength) ||
    body.contentLength <= 0 ||
    body.contentLength > MAX_FILE_BYTES
  )
    return jsonResponse(400, { error: "invalid_content_length" });
  const artifactId = randomUUID();
  const s3Key = mediaKey(siteId, complaintId, artifactId);
  const uploadUrl = await presignPut({
    bucket: getConfig().uploadBucket,
    key: s3Key,
    contentType: body.contentType,
    contentLength: body.contentLength,
    tagging: "state=pending",
    expiresIn: 300,
  });
  return jsonResponse(200, {
    artifactId,
    s3Key,
    uploadUrl,
    uploadHeaders: { "content-type": body.contentType, "if-none-match": "*" },
    expiresIn: 300,
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
    !complaintId ||
    body?.s3Key !== expected ||
    !TYPES.has(body?.contentType) ||
    typeof body?.name !== "string"
  )
    return jsonResponse(400, { error: "invalid_artifact" });
  const head = await headObject({
    bucket: getConfig().uploadBucket,
    key: expected,
  });
  if (
    head.contentType !== body.contentType ||
    head.contentLength !== body.contentLength ||
    head.contentLength > MAX_FILE_BYTES
  )
    return jsonResponse(400, { error: "media_mismatch" });
  const object = await getObjectBytes({
    bucket: getConfig().uploadBucket,
    key: expected,
  });
  let signatureValid = false;
  try {
    signatureValid = validSignature(object.bytes, body.contentType);
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
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  };
  await ddb.send(
    new PutCommand({
      TableName: getConfig().dynamoTable,
      Item: item,
      ConditionExpression: "attribute_not_exists(sk)",
    }),
  );
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
  if (!complaintId || description.length > MAX_TEXT)
    return jsonResponse(400, { error: "invalid_complaint" });
  const artifacts = await readArtifacts(siteId, complaintId);
  if (!description && !artifacts.length)
    return jsonResponse(400, { error: "complaint_content_required" });
  if (
    artifacts.length > MAX_FILES ||
    artifacts.reduce((n, a) => n + (a.contentLength || 0), 0) > MAX_TOTAL_BYTES
  )
    return jsonResponse(400, { error: "complaint_media_limit" });
  const createdAt = new Date().toISOString();
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
    expiresAt: Math.floor(Date.now() / 1000) + 365 * 86400,
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: getConfig().dynamoTable,
        Item: item,
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  } catch (error) {
    if (error?.name !== "ConditionalCheckFailedException") throw error;
  }
  const retentionExpiresAt = Math.floor(Date.now() / 1000) + 365 * 86400;
  await Promise.all(
    artifacts.flatMap((artifact) => [
      setObjectTags({
        bucket: getConfig().uploadBucket,
        key: artifact.s3Key,
        tags: { state: "complaint" },
      }),
      ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: { pk: artifact.pk, sk: artifact.sk },
          UpdateExpression: "SET expiresAt = :expiresAt",
          ExpressionAttributeValues: { ":expiresAt": retentionExpiresAt },
        }),
      ),
    ]),
  );
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: getConfig().queueUrl,
        MessageBody: JSON.stringify({
          type: "analyze_complaint",
          siteId,
          complaintId,
        }),
      }),
    );
  } catch (error) {
    await ddb.send(
      new UpdateCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
        UpdateExpression: "SET #status = :failed, label = :label",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":failed": "analysis_failed",
          ":label": "Complaint log failed",
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
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: getConfig().dynamoTable,
        Key: complaintKey(siteId, complaintId),
        UpdateExpression: "SET #status = :analyzing, label = :label",
        ConditionExpression: "#status = :failed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":analyzing": "analyzing",
          ":failed": "analysis_failed",
          ":label": "New complaint - analyzing",
        },
      }),
    );
  } catch (error) {
    if (error?.name === "ConditionalCheckFailedException")
      return jsonResponse(409, { error: "complaint_not_retryable" });
    throw error;
  }
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: getConfig().queueUrl,
      MessageBody: JSON.stringify({
        type: "analyze_complaint",
        siteId,
        complaintId,
      }),
    }),
  );
  return jsonResponse(202, { status: "analyzing" });
}

export async function deleteComplaint(event) {
  const siteId = deriveSiteId(event);
  const { complaintId } = params(event);
  const header = await ddb.send(
    new GetCommand({
      TableName: getConfig().dynamoTable,
      Key: complaintKey(siteId, complaintId),
    }),
  );
  if (!header.Item) return jsonResponse(404, { error: "complaint_not_found" });
  if (header.Item.status === "analyzing")
    return jsonResponse(409, { error: "complaint_analyzing" });
  const artifacts = await readArtifacts(siteId, complaintId);
  await Promise.all(
    artifacts.map((a) =>
      deleteObject({ bucket: getConfig().uploadBucket, key: a.s3Key }),
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
      }),
    ),
  ]);
  return jsonResponse(200, { status: "deleted" });
}

export async function deleteComplaintArtifact(event) {
  const siteId = deriveSiteId(event);
  const { complaintId, artifactId } = params(event);
  const key = complaintArtifactKey(siteId, complaintId, artifactId);
  const item = await ddb.send(
    new GetCommand({ TableName: getConfig().dynamoTable, Key: key }),
  );
  if (!item.Item) return jsonResponse(404, { error: "artifact_not_found" });
  await deleteObject({
    bucket: getConfig().uploadBucket,
    key: item.Item.s3Key,
  });
  await ddb.send(
    new DeleteCommand({ TableName: getConfig().dynamoTable, Key: key }),
  );
  return jsonResponse(200, { status: "deleted" });
}

export async function presignComplaintMedia(event) {
  const siteId = deriveSiteId(event);
  const { complaintId, artifactId } = params(event);
  const item = await ddb.send(
    new GetCommand({
      TableName: getConfig().dynamoTable,
      Key: complaintArtifactKey(siteId, complaintId, artifactId),
    }),
  );
  if (!item.Item) return jsonResponse(404, { error: "artifact_not_found" });
  return jsonResponse(200, {
    downloadUrl: await presignGet({
      bucket: getConfig().uploadBucket,
      key: item.Item.s3Key,
      expiresIn: 300,
    }),
    expiresIn: 300,
  });
}
