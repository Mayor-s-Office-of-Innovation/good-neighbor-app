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
import { artifactTaskLocationUpdates } from "../analysis/guidance/guidance-store.js";
import { queryAllItems } from "../lib/query-all-items.js";
import { emitMetrics } from "../lib/metrics.js";
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

// Upload URLs are write-capable and carry a quota reservation, so they stay
// short; the client PUTs immediately after presigning. Read URLs last an hour
// so the card/history photo renewal (<artifact-photo>) rarely has to re-sign.
// Lambda's temporary credentials bound how long a presigned URL can be
// honoured, so do not raise MEDIA_PRESIGN_EXPIRY_SECONDS past an hour.
const UPLOAD_PRESIGN_EXPIRY_SECONDS = 300;
const MEDIA_PRESIGN_EXPIRY_SECONDS = 3600;
// Every check/task photo leaves the bucket 30 days after upload (bucket
// lifecycle rule). A read URL must not outlive that boundary.
const MEDIA_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_ARTIFACT_TEXT_LENGTH = 4000;
// The Street Conditions analysis service rejects text media under 5 characters
// as an invalid request (permanent, non-retryable) — reject it here instead so
// the client sees a 400 rather than a dead artifact.
const MIN_ARTIFACT_TEXT_LENGTH = 5;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_CHECK_ARTIFACTS = 20;
const MAX_CHECK_BYTES = 50 * 1024 * 1024;
export const MAX_DEVICE_DAILY_BYTES = 100 * 1024 * 1024;
export const MAX_DEVICE_DAILY_ARTIFACTS = 50;

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

  // Log only diagnostic scalars, never request bodies, media, or credentials.
  // Keep the public responses stable while distinguishing size failures in logs.
  /**
   * @param {string} error
   * @param {string} reason
   * @param {unknown} [contentLength]
   * @returns {import("aws-lambda").APIGatewayProxyResult} Unchanged validation response.
   */
  const rejectUpload = (error, reason, contentLength) => {
    console.warn(
      JSON.stringify({
        level: "warn",
        marker: "UploadValidationRejected",
        requestId: event.requestContext?.requestId,
        siteId,
        reason,
        declaredBytes:
          typeof contentLength === "number" && Number.isFinite(contentLength)
            ? contentLength
            : null,
        maxBytes: MAX_OBJECT_BYTES,
      }),
    );
    return jsonResponse(400, { error });
  };

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return rejectUpload("Missing checkId", "missing_check_id");

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return rejectUpload("Invalid JSON body", "invalid_json");
  }
  const { contentType, contentLength } =
    /** @type {{ contentType?: unknown, contentLength?: unknown }} */ (
      body ?? {}
    );

  // Task documentation also accepts HEIC/HEIF. Analysis registration below
  // deliberately retains the narrower analyzer-supported content types.
  if (
    typeof contentType !== "string" ||
    !(
      ALLOWED_CONTENT_TYPES.has(contentType) ||
      ["image/heic", "image/heif"].includes(contentType)
    )
  ) {
    return rejectUpload(
      "Unsupported or missing contentType",
      "unsupported_content_type",
      contentLength,
    );
  }
  if (
    !Number.isInteger(contentLength) ||
    Number(contentLength) <= 0 ||
    Number(contentLength) > MAX_OBJECT_BYTES
  ) {
    const reason = !Number.isInteger(contentLength)
      ? "invalid_content_length"
      : Number(contentLength) <= 0
        ? "non_positive_content_length"
        : "photo_too_large";
    return rejectUpload("invalid_content_length", reason, contentLength);
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
      const reasons =
        /** @type {{ CancellationReasons?: Array<{ Code?: string }> }} */ (
          error
        ).CancellationReasons;
      console.warn(
        JSON.stringify({
          // Retain the existing metric marker and public response. The marker
          // alone does not prove a quota was exhausted: cancellations can also
          // be conflicts. Log codes by transaction position, never Item/Message.
          marker: "MediaQuotaExceeded",
          siteId,
          checkId,
          errorName: error.name,
          cancellationReasons: Array.isArray(reasons)
            ? reasons.map((reason, index) => ({
                operation:
                  [
                    "check_state",
                    "check_quota",
                    "device_quota",
                    "upload_reservation",
                  ][index] ?? "unknown",
                code: reason?.Code ?? "Unknown",
              }))
            : null,
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
    expiresIn: UPLOAD_PRESIGN_EXPIRY_SECONDS,
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
    expiresIn: UPLOAD_PRESIGN_EXPIRY_SECONDS,
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
 * optional `contentType`, `capturedAt`, `latitude` + `longitude` (+ `accuracyMeters`). Legacy
 * `placeId` / `placeName` fields from pre-Phase-2 clients are ignored.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const registerArtifact = async (event) => {
  const { dynamoTable, queueUrl, analysisQueueUrl } = getConfig();
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
    accuracyMeters,
    text,
    language,
  } =
    /** @type {{ artifactId?: unknown, s3Key?: unknown, contentType?: unknown, contentLength?: unknown, capturedAt?: unknown, latitude?: unknown, longitude?: unknown, accuracyMeters?: unknown, text?: unknown, language?: unknown }} */ (
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
  // Picks the 311 point among fixes; drop a bad value rather than fail the photo.
  const hasAccuracy =
    hasCoordinates &&
    typeof accuracyMeters === "number" &&
    Number.isFinite(accuracyMeters) &&
    accuracyMeters >= 0;
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
    receivedAt: now,
    ...(hasCoordinates ? { latitude, longitude } : {}),
    ...(hasAccuracy ? { accuracyMeters } : {}),
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
    // Clears the presign's `state=pending` tag so the 1-day pending rule leaves
    // the object alone; the bucket-wide 30-day rule owns it from here.
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
      QueueUrl: analysisQueueUrl || queueUrl,
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
 * @param {Record<string, unknown> | undefined} item
 * @returns {{ latitude: number, longitude: number, accuracyMeters?: number } | null}
 */
function storedLocation(item) {
  const { latitude, longitude, accuracyMeters } = item ?? {};
  if (typeof latitude !== "number" || typeof longitude !== "number")
    return null;
  // 0,0 is the placeholder for a photo without a fix.
  if (latitude === 0 && longitude === 0) return null;
  return {
    latitude,
    longitude,
    ...(typeof accuracyMeters === "number" ? { accuracyMeters } : {}),
  };
}

/**
 * PATCH /v1/checks/{checkId}/artifacts/{artifactId}/location — a GPS reading
 * that arrived after the photo was sent, so analysis never waits for it.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const updateArtifactLocation = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const checkId = event.pathParameters?.checkId;
  if (!checkId) return jsonResponse(400, { error: "Missing checkId" });
  const artifactId = event.pathParameters?.artifactId;
  if (!artifactId) return jsonResponse(400, { error: "Missing artifactId" });

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const { latitude, longitude, accuracyMeters } =
    /** @type {{ latitude?: unknown, longitude?: unknown, accuracyMeters?: unknown }} */ (
      body ?? {}
    );
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (latitude === 0 && longitude === 0) ||
    (accuracyMeters !== undefined &&
      (typeof accuracyMeters !== "number" ||
        !Number.isFinite(accuracyMeters) ||
        accuracyMeters < 0))
  ) {
    return jsonResponse(400, { error: "invalid_location" });
  }
  const location = {
    latitude,
    longitude,
    ...(accuracyMeters !== undefined ? { accuracyMeters } : {}),
  };

  const result = await queryAllItems({
    TableName: dynamoTable,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": sitePk(siteId),
      ":prefix": checkArtifactPrefix(checkId),
    },
    // The PATCH can follow register by milliseconds; a stale read would 404.
    ConsistentRead: true,
  });
  const artifact = result.Items.find((it) => it.artifactId === artifactId);
  if (!artifact) return jsonResponse(404, { error: "Artifact not found" });

  const hasAccuracy = location.accuracyMeters !== undefined;
  const artifactItem = {
    Update: {
      TableName: dynamoTable,
      Key: { pk: sitePk(siteId), sk: artifact.sk },
      UpdateExpression: `SET latitude = :lat, longitude = :lng${
        hasAccuracy ? ", accuracyMeters = :acc" : ""
      }`,
      ConditionExpression: hasAccuracy
        ? "attribute_exists(sk) AND (attribute_not_exists(latitude) OR attribute_not_exists(accuracyMeters) OR accuracyMeters > :acc)"
        : "attribute_exists(sk) AND attribute_not_exists(latitude)",
      ExpressionAttributeValues: {
        ":lat": location.latitude,
        ":lng": location.longitude,
        ...(hasAccuracy ? { ":acc": location.accuracyMeters } : {}),
      },
    },
  };
  /** @type {Map<string, "queued" | "submitted">} */
  const filedTasks = new Map();
  /** @param {{ taskId: string, state: "queued" | "submitted" }[]} tasks */
  const onFiled = (tasks) =>
    tasks.forEach(({ taskId, state }) => filedTasks.set(taskId, state));
  let items = [
    artifactItem,
    ...(await artifactTaskLocationUpdates({
      tableName: dynamoTable,
      siteId,
      checkId,
      artifactId,
      location,
      onFiled,
    })),
  ];
  let taskLocation = location;
  let rereadTasks = true;
  // A row that already has a better reading, or a task filed meanwhile, fails
  // its check and cancels the batch; drop it and save the rest.
  while (items.length > 0) {
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
      break;
    } catch (err) {
      const reasons =
        err instanceof Error && err.name === "TransactionCanceledException"
          ? /** @type {{ CancellationReasons?: { Code?: string }[] }} */ (err)
              .CancellationReasons
          : undefined;
      const failed = new Set(
        (reasons ?? []).flatMap((reason, index) =>
          reason?.Code === "ConditionalCheckFailed" ? [index] : [],
        ),
      );
      if (failed.size === 0) throw err;
      // The photo already has a better reading; give its tasks that one instead.
      if (items[0] === artifactItem && failed.has(0)) {
        const stored = await ddb.send(
          new GetCommand({
            TableName: dynamoTable,
            Key: { pk: sitePk(siteId), sk: artifact.sk },
            ConsistentRead: true,
          }),
        );
        const better = storedLocation(stored.Item);
        if (!better) {
          items = [];
          break;
        }
        taskLocation = better;
        items = await artifactTaskLocationUpdates({
          tableName: dynamoTable,
          siteId,
          checkId,
          artifactId,
          location: taskLocation,
        });
        continue;
      }
      // Another writer may have bumped a task's updatedAt; read the tasks once more.
      if (rereadTasks) {
        rereadTasks = false;
        items = [
          ...items.filter((item) => item === artifactItem),
          ...(await artifactTaskLocationUpdates({
            tableName: dynamoTable,
            siteId,
            checkId,
            artifactId,
            location: taskLocation,
            ...(taskLocation === location ? { onFiled } : {}),
          })),
        ];
        continue;
      }
      items = items.filter((_, index) => !failed.has(index));
    }
  }
  const artifactUpdated = items.includes(artifactItem);
  const tasksUpdated = items.length - (artifactUpdated ? 1 : 0);
  if (artifactUpdated) {
    // Counts late GPS fixes that miss a 311 ticket (#683). If it shows up, add
    // code to update the ticket's location when a late fix arrives.
    for (const [taskId, state] of filedTasks) {
      emitMetrics({
        marker: "LateLocationAfterFiling",
        metrics: [{ name: "LateLocationAfterFiling", value: 1 }],
        props: { siteId, checkId, artifactId, taskId, filing: state },
      });
    }
  }
  return jsonResponse(200, { artifactId, artifactUpdated, tasksUpdated });
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
 * sign another's media. Also signs the card thumbnail (`thumbnailUrl`) when the
 * worker has recorded one on the row.
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
  const tenantPrefix = `checks/${siteId}/${checkId}/`;
  if (!artifact.s3Key.startsWith(tenantPrefix)) {
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

  // Cap the URL at the bucket's 30-day retention boundary, measured from the
  // row's upload time. Rows without a parseable timestamp (legacy fixtures)
  // get the full TTL. A photo already past retention still gets a short URL:
  // S3 answers 404 and the client shows its "unavailable" placeholder, the same
  // path as today, rather than a new error shape.
  const uploadedAt = Date.parse(artifact.receivedAt || artifact.capturedAt);
  const remaining = Number.isFinite(uploadedAt)
    ? Math.floor(
        (uploadedAt + MEDIA_RETENTION_SECONDS * 1000 - Date.now()) / 1000,
      )
    : MEDIA_PRESIGN_EXPIRY_SECONDS;
  const expiresIn = Math.max(
    60,
    Math.min(MEDIA_PRESIGN_EXPIRY_SECONDS, remaining),
  );

  /** @param {string} key */
  const sign = (key) =>
    presignGet({
      bucket: uploadBucket,
      key,
      expiresIn,
    });
  // The worker stores a small card variant beside the original (see
  // media/thumbnail.js) and records its key on the row. Sign it under the same
  // tenant rule, best-effort: a row without one (not yet analyzed, a
  // task-update photo, or a failed write) just gets the original, which the
  // client already handles, and so does a thumbnail that fails to sign.
  const thumbS3Key =
    typeof artifact.thumbS3Key === "string" &&
    artifact.thumbS3Key.startsWith(tenantPrefix)
      ? artifact.thumbS3Key
      : undefined;
  const [downloadUrl, thumbnailUrl] = await Promise.all([
    sign(
      artifact.entityType === "task_update_media" &&
        typeof artifact.displayS3Key === "string" &&
        artifact.displayS3Key === `${artifact.s3Key}.display.jpg`
        ? artifact.displayS3Key
        : artifact.s3Key,
    ),
    thumbS3Key ? sign(thumbS3Key).catch(() => undefined) : undefined,
  ]);

  return jsonResponse(200, {
    artifactId,
    s3Key: artifact.s3Key,
    downloadUrl,
    thumbnailUrl,
    expiresIn,
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
export function quotaUpdate({
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
