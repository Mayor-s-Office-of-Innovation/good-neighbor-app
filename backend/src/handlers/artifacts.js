import { randomUUID } from "node:crypto";
import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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
const MAX_ARTIFACT_TEXT_LENGTH = 4000;
// The Street Conditions analysis service rejects text media under 5 characters
// as an invalid request (permanent, non-retryable) — reject it here instead so
// the client sees a 400 rather than a dead artifact.
const MIN_ARTIFACT_TEXT_LENGTH = 5;

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
 * never transit our API). No DB write happens here; the artifact becomes real
 * at `registerArtifact`. content-type is pinned into the signature.
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
  const { contentType } = /** @type {{ contentType?: unknown }} */ (body ?? {});

  if (
    typeof contentType !== "string" ||
    !ALLOWED_CONTENT_TYPES.has(contentType)
  ) {
    return jsonResponse(400, { error: "Unsupported or missing contentType" });
  }

  const artifactId = randomUUID();
  const key = mediaKey(siteId, checkId, artifactId);
  const uploadUrl = await presignPut({
    bucket: uploadBucket,
    key,
    contentType,
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });

  return jsonResponse(200, {
    artifactId,
    s3Key: key,
    contentType,
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
 * JWT, enforced at the application layer; the IAM LeadingKeys condition is the
 * target-design backstop, not yet in the deployed role) plus the s3Key prefix check
 * below — NOT a parent-header lookup. We deliberately do not read the CHECK header
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
    capturedAt,
    latitude,
    longitude,
    text,
  } =
    /** @type {{ artifactId?: unknown, s3Key?: unknown, contentType?: unknown, capturedAt?: unknown, latitude?: unknown, longitude?: unknown, text?: unknown }} */ (
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
  if (hasS3Key && !s3Key.startsWith(`checks/${siteId}/${checkId}/`)) {
    return jsonResponse(400, { error: "s3Key does not belong to this check" });
  }

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
      ProjectionExpression: "status",
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
