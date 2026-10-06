import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { ddb } from "../db.js";
import { headObject, presignGet, presignPut, setObjectTags } from "../s3.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import {
  artifactKey,
  checkArtifactPrefix,
  checkHeaderKey,
  sitePk,
  taskUpdateMediaPointerKey,
} from "./keys.js";

const sqs = new SQSClient({});

// MVP capture types. Audio is out of scope for Step C (images + text only).
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const PRESIGN_EXPIRY_SECONDS = 300;
const MAX_ARTIFACT_TEXT_LENGTH = 4000;
// The Street Conditions analysis service rejects text media under 5 characters
// as an invalid request (permanent, non-retryable) — reject it here instead so
// the client sees a 400 rather than a dead artifact.
const MIN_ARTIFACT_TEXT_LENGTH = 5;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_CHECK_ARTIFACTS = 20;
const MAX_CHECK_BYTES = 50 * 1024 * 1024;
const MAX_DEVICE_DAILY_BYTES = 100 * 1024 * 1024;
const MAX_SITE_DAILY_BYTES = 1024 * 1024 * 1024;
const MAX_GLOBAL_DAILY_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_DEVICE_DAILY_ARTIFACTS = 50;
const MAX_SITE_DAILY_ARTIFACTS = 1000;
const MAX_GLOBAL_DAILY_ARTIFACTS = 10000;

/**
 * S3 layout for a check's media. Server-owned and tenant-prefixed, so a
 * presigned PUT can only ever land inside this exact site + check, and
 * `registerArtifact` can reject any key that doesn't. Objects written before
 * ADR 0014 Phase 2 carry an extra `<placeId>` segment; nothing reconstructs a
 * key from parts, so they stay readable through the stored `s3Key`.
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} artifactId
 * @returns {string}
 */
const mediaKey = (siteId, checkId, artifactId) =>
  `checks/${siteId}/${checkId}/${artifactId}`;

/**
 * POST /v1/checks/{checkId}/artifacts:presign — mint an `artifactId` + S3 key
 * and return a presigned PUT so the device uploads media straight to S3 (bytes
 * never transit our API). A conservative quota reservation is persisted before
 * signing; the artifact becomes visible at `registerArtifact`. Content type,
 * byte length, and no-overwrite semantics are pinned into the signature.
 *
 * Body: `contentType` (required, one of ALLOWED_CONTENT_TYPES). Legacy
 * `placeId` / `placeName` fields from pre-Phase-2 clients are ignored.
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
  const { contentType, contentLength } =
    /** @type {{ contentType?: unknown, contentLength?: unknown }} */ (
      body ?? {}
    );

  if (
    typeof contentType !== "string" ||
    !ALLOWED_CONTENT_TYPES.has(contentType)
  ) {
    return jsonResponse(400, { error: "Unsupported or missing contentType" });
  }
  if (
    !Number.isInteger(contentLength) ||
    Number(contentLength) <= 0 ||
    Number(contentLength) > MAX_OBJECT_BYTES
  ) {
    return jsonResponse(400, { error: "invalid_content_length" });
  }

  const artifactId = randomUUID();
  const key = mediaKey(siteId, checkId, artifactId);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const expiresAt = Math.floor(now.getTime() / 1000) + 24 * 60 * 60;
  const bytes = Number(contentLength);
  const tableName = getConfig().dynamoTable;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: checkHeaderKey(siteId, checkId),
              ConditionExpression:
                "attribute_exists(pk) AND #status IN (:inProgress, :completed)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":inProgress": "in_progress",
                ":completed": "completed",
              },
            },
          },
          quotaUpdate({
            tableName,
            key: {
              pk: sitePk(siteId),
              sk: `MEDIA_QUOTA#${day}#CHECK#${checkId}`,
            },
            bytes,
            maxBytes: MAX_CHECK_BYTES,
            countField: "reservedCount",
            maxCount: MAX_CHECK_ARTIFACTS,
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
          quotaUpdate({
            tableName,
            key: { pk: sitePk(siteId), sk: `MEDIA_QUOTA#${day}#SITE` },
            bytes,
            maxBytes: MAX_SITE_DAILY_BYTES,
            countField: "reservedCount",
            maxCount: MAX_SITE_DAILY_ARTIFACTS,
            expiresAt,
          }),
          quotaUpdate({
            tableName,
            key: { pk: `MEDIA_QUOTA#${day}`, sk: "#GLOBAL" },
            bytes,
            maxBytes: MAX_GLOBAL_DAILY_BYTES,
            countField: "reservedCount",
            maxCount: MAX_GLOBAL_DAILY_ARTIFACTS,
            expiresAt,
          }),
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: sitePk(siteId),
                sk: `UPLOAD_RESERVATION#${checkId}#${artifactId}`,
                type: "uploadReservation",
                siteId,
                checkId,
                artifactId,
                s3Key: key,
                contentType,
                contentLength: bytes,
                status: "pending",
                createdAt: now.toISOString(),
                expiresAt,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "TransactionCanceledException",
        "ConditionalCheckFailedException",
      ].includes(error.name)
    ) {
      console.warn(
        JSON.stringify({
          marker: "MediaQuotaExceeded",
          siteId,
          checkId,
        }),
      );
      return jsonResponse(429, { error: "media_quota_exceeded" });
    }
    throw error;
  }
  const uploadUrl = await presignPut({
    bucket: uploadBucket,
    key,
    contentType,
    contentLength: bytes,
    tagging: "state=pending",
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });

  return jsonResponse(200, {
    artifactId,
    s3Key: key,
    contentType,
    contentLength: bytes,
    // The AWS presigner hoists declared-bytes metadata into the signed query
    // string. Sending it again as an x-amz-meta-* request header makes MinIO
    // reject the PUT as an unsigned duplicate header.
    uploadHeaders: {
      "content-type": contentType,
      "if-none-match": "*",
    },
    uploadUrl,
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });
};

/**
 * POST /v1/checks/{checkId}/artifacts — record an uploaded artifact and enqueue
 * its analysis. A single conditional Put of the ART item (attribute_not_exists,
 * so a replay can't duplicate it); only then do we enqueue — the message carries
 * the S3 key, never the media bytes.
 *
 * Tenant isolation is the partition key (`SITE#<siteId>`, siteId derived from the
 * JWT) plus the exact, server-owned S3 key check below — NOT a parent-header lookup.
 * We deliberately do not read the CHECK header
 * here. It used to be a ConditionCheck in a TransactWrite, but that routed every
 * one of a submit's parallel registrations through the same header item, and
 * DynamoDB cancels concurrent transactions contending on a shared item
 * (TransactionConflict) — surfacing as a spurious 409 on multi-photo submits. The
 * client always awaits createCheck before uploading, and getCheck/completeCheck
 * key off the header (a would-be orphan is simply never read), so "parent exists"
 * is a client-guaranteed invariant rather than one re-proven on every photo.
 *
 * Body: `artifactId` (required); one of `s3Key` (from presign) or `text`;
 * optional `contentType`, `capturedAt`, `latitude` + `longitude`. Legacy
 * `placeId` / `placeName` fields from pre-Phase-2 clients are ignored.
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
  const {
    artifactId,
    s3Key,
    contentType,
    contentLength,
    capturedAt,
    latitude,
    longitude,
    text,
    language,
  } =
    /** @type {{ artifactId?: unknown, s3Key?: unknown, contentType?: unknown, contentLength?: unknown, capturedAt?: unknown, latitude?: unknown, longitude?: unknown, text?: unknown, language?: unknown }} */ (
      body ?? {}
    );

  if (typeof artifactId !== "string" || !artifactId) {
    return jsonResponse(400, { error: "Missing artifactId" });
  }
  const hasS3Key = typeof s3Key === "string" && s3Key.length > 0;
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const hasText = normalizedText.length > 0;
  if (!hasS3Key && !hasText) {
    return jsonResponse(400, { error: "Missing s3Key or text" });
  }
  if (hasText && normalizedText.length < MIN_ARTIFACT_TEXT_LENGTH) {
    return jsonResponse(400, {
      error: `text must be at least ${MIN_ARTIFACT_TEXT_LENGTH} characters`,
    });
  }
  if (normalizedText.length > MAX_ARTIFACT_TEXT_LENGTH) {
    return jsonResponse(400, {
      error: `text must be ${MAX_ARTIFACT_TEXT_LENGTH} characters or fewer`,
    });
  }
  const hasLatitude = latitude !== undefined;
  const hasLongitude = longitude !== undefined;
  const hasCoordinates =
    hasLatitude &&
    hasLongitude &&
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
  if ((hasLatitude || hasLongitude) && !hasCoordinates) {
    return jsonResponse(400, { error: "invalid_location" });
  }
  // No-graft: the key the client hands back must live under this site + check.
  if (hasS3Key && s3Key !== mediaKey(siteId, checkId, artifactId)) {
    return jsonResponse(400, { error: "s3Key does not belong to this check" });
  }
  let verifiedContentLength;
  if (hasS3Key) {
    if (
      typeof contentType !== "string" ||
      !ALLOWED_CONTENT_TYPES.has(contentType) ||
      !Number.isInteger(contentLength) ||
      Number(contentLength) <= 0 ||
      Number(contentLength) > MAX_OBJECT_BYTES
    ) {
      return jsonResponse(400, { error: "invalid_media_metadata" });
    }
    let object;
    try {
      object = await headObject({
        bucket: getConfig().uploadBucket,
        key: s3Key,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ["NotFound", "NoSuchKey"].includes(error.name)
      ) {
        return jsonResponse(409, { error: "media_upload_missing" });
      }
      throw error;
    }
    if (
      object.contentType !== contentType ||
      object.contentLength !== Number(contentLength) ||
      object.metadata?.["declared-bytes"] !== String(contentLength)
    ) {
      await setObjectTags({
        bucket: getConfig().uploadBucket,
        key: s3Key,
        tags: { state: "rejected" },
      });
      return jsonResponse(422, { error: "media_metadata_mismatch" });
    }
    verifiedContentLength = Number(contentLength);
  }

  // The requester's locale for analyzer-written text. The analyzer falls back
  // to English on unknown tags, so this is pass-through, not an allowlist.
  const languageValue =
    typeof language === "string" && language.trim()
      ? language.trim()
      : undefined;

  const now = new Date().toISOString();
  // Per-photo capture time. The worker forwards this as the analyzer's
  // `reported_at`, so it must describe THIS artifact, not the batch.
  const capturedAtValue = typeof capturedAt === "string" ? capturedAt : now;
  const item = {
    ...artifactKey(siteId, checkId, artifactId),
    checkId,
    artifactId,
    ...(hasS3Key ? { s3Key } : {}),
    capturedAt: capturedAtValue,
    ...(hasCoordinates ? { latitude, longitude } : {}),
    ...(typeof contentType === "string" ? { contentType } : {}),
    ...(verifiedContentLength ? { contentLength: verifiedContentLength } : {}),
    ...(hasText ? { text: normalizedText } : {}),
  };

  let alreadyRegistered = false;
  try {
    await ddb.send(
      new PutCommand({
        TableName: dynamoTable,
        Item: item,
        // No duplicate: write only if this artifactId isn't already registered.
        // Touches only this artifact's own item, so a submit's parallel
        // registrations never contend (see the header note above).
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // The ART item already exists — but the Put and the SQS send below are not
      // atomic, so a PRIOR attempt may have persisted the item then failed before
      // enqueuing (or its 202 was lost and the client retried). We can't tell
      // "already queued" from "persisted but never queued", so we fall through and
      // (re)enqueue anyway rather than returning here. The worker's ANALYSIS# write
      // is conditional/idempotent, so a duplicate analyze message is harmless —
      // and NOT re-enqueuing would strand an artifact that exists-but-was-never-
      // queued, hanging the client's waitForAnalyses poll until it times out.
      alreadyRegistered = true;
    } else {
      throw err;
    }
  }

  if (hasS3Key) {
    await setObjectTags({
      bucket: getConfig().uploadBucket,
      key: s3Key,
      tags: { state: "registered" },
    });
  }

  // Media bytes NEVER travel through the queue — only the S3 key the worker
  // will fetch, downscale, and forward to the analyzer. Enqueued on BOTH the fresh
  // and the already-registered path (see above) so analysis is always driven.
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        siteId,
        checkId,
        artifactId,
        capturedAt: capturedAtValue,
        ...(hasCoordinates ? { latitude, longitude } : {}),
        ...(hasS3Key ? { s3Key } : {}),
        ...(hasText ? { text: normalizedText } : {}),
        ...(languageValue ? { language: languageValue } : {}),
      }),
    }),
  );

  // Keep 409 on replay so the client still learns this was a duplicate; the
  // enqueue above means treating that 409 as success is now safe.
  return alreadyRegistered
    ? jsonResponse(409, { error: "artifact already registered" })
    : jsonResponse(202, { artifactId, status: "queued" });
};

/**
 * DELETE /v1/checks/{checkId}/artifacts/{artifactId} — remove a registered
 * artifact from its check. The client needs this when a user edits or deletes
 * a saved description: the old text was already registered (and analyzed), so
 * leaving the ART# row in place would let completeCheck fold the stale text
 * into the final scorecard alongside the replacement.
 *
 * The route carries only checkId + artifactId. Rows written before ADR 0014
 * Phase 2 embed a retired place id in the ART# sort key, so we query this
 * check's ART# items and match on `artifactId` rather than rebuild the key
 * (same resolution presignMedia uses). Scoped to the derived site, so one
 * tenant can never delete another's artifact. The ANALYSIS# item is left in
 * place: completeCheck synthesizes only analyses whose artifact still has an
 * ART# row, so the orphaned analysis is naturally excluded from the fold, and
 * the coverage gate never blocks on it.
 *
 * Idempotent: deleting an unknown artifact (already deleted, never registered)
 * 404s. Completed checks are not editable — the scorecard is already folded.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const deleteArtifact = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });
  const artifactId = event.pathParameters?.artifactId;
  if (!artifactId) return jsonResponse(400, { error: "Missing artifactId" });

  const headerResult = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND sk = :sk",
      ExpressionAttributeValues: {
        ":pk": sitePk(siteId),
        ":sk": checkHeaderKey(siteId, checkId).sk,
      },
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  const header = (headerResult.Items ?? [])[0];
  if (!header) return jsonResponse(404, { error: "Check not found" });
  if (header.status === "completed") {
    return jsonResponse(409, { error: "Check already completed" });
  }

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
  if (!artifact) return jsonResponse(404, { error: "Artifact not found" });

  await ddb.send(
    new DeleteCommand({
      TableName: dynamoTable,
      Key: {
        pk: sitePk(siteId),
        sk: artifact.sk,
      },
    }),
  );

  return jsonResponse(200, { artifactId, status: "deleted" });
};

/**
 * GET /v1/checks/{checkId}/artifacts/{artifactId}/media — mint a short-lived
 * presigned GET so staff can review the original photo. The route carries only
 * checkId + artifactId; pre-Phase-2 rows embed a retired place id in the sort
 * key, so we query this check's ART# items and match on `artifactId` (rather
 * than reconstruct the key). Scoped to the derived site, so one tenant can never
 * sign another's media.
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

  let artifact = (result.Items ?? []).find(
    (it) => it.artifactId === artifactId,
  );
  if (!artifact) {
    const pointer = await ddb.send(
      new GetCommand({
        TableName: dynamoTable,
        Key: taskUpdateMediaPointerKey(siteId, checkId, artifactId),
        ConsistentRead: true,
      }),
    );
    if (pointer?.Item?.mediaSk) {
      const media = await ddb.send(
        new GetCommand({
          TableName: dynamoTable,
          Key: { pk: sitePk(siteId), sk: pointer.Item.mediaSk },
          ConsistentRead: true,
        }),
      );
      artifact = media.Item;
    }
  }
  if (!artifact || typeof artifact.s3Key !== "string") {
    return jsonResponse(404, { error: "Artifact not found" });
  }
  // Stored data is still treated as untrusted. Never sign a key outside the
  // caller's tenant even if a legacy/corrupt row points there.
  if (!artifact.s3Key.startsWith(`checks/${siteId}/${checkId}/`)) {
    console.error(
      JSON.stringify({
        marker: "MediaTenantMismatch",
        siteId,
        checkId,
        artifactId,
      }),
    );
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

/**
 * Build one conditional quota reservation update for a DynamoDB transaction.
 * @param {object} input
 * @param {string} input.tableName
 * @param {{pk:string, sk:string}} input.key
 * @param {number} input.bytes
 * @param {number} input.maxBytes
 * @param {string} [input.byteField]
 * @param {string} [input.countField]
 * @param {number} [input.maxCount]
 * @param {number} [input.expiresAt]
 * @returns {Record<string, any>}
 */
function quotaUpdate({
  tableName,
  key,
  bytes,
  maxBytes,
  byteField = "reservedBytes",
  countField,
  maxCount,
  expiresAt,
}) {
  /** @type {Record<string, string>} */
  const names = { "#bytes": byteField };
  /** @type {Record<string, string | number | undefined>} */
  const values = {
    ":bytes": bytes,
    ":remaining": maxBytes - bytes,
    ...(countField ? { ":one": 1, ":maxCount": maxCount } : {}),
    ...(expiresAt ? { ":expiresAt": expiresAt } : {}),
  };
  if (countField) names["#count"] = countField;
  const update = `ADD #bytes :bytes${countField ? ", #count :one" : ""}${expiresAt ? " SET expiresAt = :expiresAt" : ""}`;
  const conditions = [
    "(attribute_not_exists(#bytes) OR #bytes <= :remaining)",
    ...(countField
      ? ["(attribute_not_exists(#count) OR #count < :maxCount)"]
      : []),
  ];
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: update,
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}
