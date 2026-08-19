import { randomUUID } from "node:crypto";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ddb } from "../db.js";
import { presignGet, presignPut } from "../s3.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import {
  artifactKey,
  checkArtifactPrefix,
  checkHeaderKey,
  sitePk,
} from "./keys.js";

const sqs = new SQSClient({});

// MVP capture types. Audio is out of scope for Step C (images + text only).
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const PRESIGN_EXPIRY_SECONDS = 300;

/**
 * S3 layout for a check's media. Server-owned and tenant-prefixed, so a
 * presigned PUT can only ever land inside this exact site + check, and
 * `registerArtifact` can reject any key that doesn't.
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} side
 * @param {string} artifactId
 * @returns {string}
 */
const mediaKey = (siteId, checkId, side, artifactId) =>
  `checks/${siteId}/${checkId}/${side}/${artifactId}`;

/**
 * POST /v1/checks/{checkId}/artifacts:presign — mint an `artifactId` + S3 key
 * and return a presigned PUT so the device uploads media straight to S3 (bytes
 * never transit our API). No DB write happens here; the artifact becomes real
 * at `registerArtifact`. content-type is pinned into the signature.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const presignUpload = async (event) => {
  const { uploadBucket } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const { side, contentType } =
    /** @type {{ side?: unknown, contentType?: unknown }} */ (body ?? {});

  if (typeof side !== "string" || side.length === 0) {
    return jsonResponse(400, { error: "Missing side" });
  }
  if (
    typeof contentType !== "string" ||
    !ALLOWED_CONTENT_TYPES.has(contentType)
  ) {
    return jsonResponse(400, { error: "Unsupported or missing contentType" });
  }

  const artifactId = randomUUID();
  const key = mediaKey(siteId, checkId, side, artifactId);
  const uploadUrl = await presignPut({
    bucket: uploadBucket,
    key,
    contentType,
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });

  return jsonResponse(200, {
    artifactId,
    side,
    s3Key: key,
    contentType,
    uploadUrl,
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });
};

/**
 * POST /v1/checks/{checkId}/artifacts — record an uploaded artifact and enqueue
 * its analysis. Writes are a TransactWrite: a ConditionCheck that the parent
 * CHECK header exists (no grafting an artifact onto a missing/foreign check)
 * plus a conditional Put of the ART item (no duplicate). Only then do we enqueue
 * — the message carries the S3 key, never the media bytes.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const registerArtifact = async (event) => {
  const { dynamoTable, queueUrl } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const { artifactId, side, s3Key, contentType, capturedAt, text } =
    /** @type {{ artifactId?: unknown, side?: unknown, s3Key?: unknown, contentType?: unknown, capturedAt?: unknown, text?: unknown }} */ (
      body ?? {}
    );

  if (typeof artifactId !== "string" || !artifactId) {
    return jsonResponse(400, { error: "Missing artifactId" });
  }
  if (typeof side !== "string" || !side) {
    return jsonResponse(400, { error: "Missing side" });
  }
  if (typeof s3Key !== "string" || !s3Key) {
    return jsonResponse(400, { error: "Missing s3Key" });
  }
  // No-graft: the key the client hands back must live under this site + check.
  if (!s3Key.startsWith(`checks/${siteId}/${checkId}/`)) {
    return jsonResponse(400, { error: "s3Key does not belong to this check" });
  }

  const now = new Date().toISOString();
  // Per-photo capture time. The worker forwards this as the analyzer's
  // `reported_at`, so it must describe THIS artifact, not the batch.
  const capturedAtValue = typeof capturedAt === "string" ? capturedAt : now;
  const item = {
    ...artifactKey(siteId, checkId, side, artifactId),
    checkId,
    artifactId,
    side,
    s3Key,
    capturedAt: capturedAtValue,
    ...(typeof contentType === "string" ? { contentType } : {}),
    ...(typeof text === "string" ? { text } : {}),
  };

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: dynamoTable,
              Key: checkHeaderKey(siteId, checkId),
              ConditionExpression: "attribute_exists(sk)",
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: item,
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      // Parent check missing, or this artifact was already registered.
      return jsonResponse(409, {
        error: "check not found or artifact already registered",
      });
    }
    throw err;
  }

  // Media bytes NEVER travel through the queue — only the S3 key the worker
  // will fetch, downscale, and forward to the analyzer.
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        siteId,
        checkId,
        artifactId,
        s3Key,
        side,
        capturedAt: capturedAtValue,
        ...(typeof text === "string" ? { text } : {}),
      }),
    }),
  );

  return jsonResponse(202, { artifactId, status: "queued" });
};

/**
 * GET /v1/checks/{checkId}/artifacts/{artifactId}/media — mint a short-lived
 * presigned GET so staff can review the original photo. The route carries only
 * checkId + artifactId, but the sort key embeds `side`, so we query this check's
 * ART# items and match on `artifactId` (rather than reconstruct the key). Scoped
 * to the derived site, so one tenant can never sign another's media.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const presignMedia = async (event) => {
  const { dynamoTable, uploadBucket } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });
  const artifactId = event.pathParameters?.artifactId;
  if (!artifactId) return jsonResponse(400, { error: "Missing artifactId" });

  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": sitePk(siteId),
        ":prefix": checkArtifactPrefix(checkId),
      },
    }),
  );

  const artifact = (result.Items ?? []).find(
    (it) => it.artifactId === artifactId,
  );
  if (!artifact || typeof artifact.s3Key !== "string") {
    return jsonResponse(404, { error: "Artifact not found" });
  }

  const downloadUrl = await presignGet({
    bucket: uploadBucket,
    key: artifact.s3Key,
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });

  return jsonResponse(200, {
    artifactId,
    s3Key: artifact.s3Key,
    downloadUrl,
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });
};
