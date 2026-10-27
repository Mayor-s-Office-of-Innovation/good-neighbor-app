import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import {
  getObjectBytes,
  headObject,
  presignGet,
  presignPut,
  putObject,
  setObjectTags,
} from "../s3.js";
import { downscaleImage, DownscaleError } from "../media/downscale.js";
import { sitePk, GSI1_NAME } from "./keys.js";
import {
  quotaUpdate,
  MAX_DEVICE_DAILY_BYTES,
  MAX_DEVICE_DAILY_ARTIFACTS,
} from "./artifacts.js";

export const CARE_WORK_TYPES = new Set([
  "power_washed",
  "called_hauler",
  "cleaned_graffiti",
  "offered_help",
  "offered_services_at_site",
  "picked_up_needles",
  "referred_non_client",
  "called_shelter",
  "addressed_client_issue",
  "other",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DAY = 86400;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
/**
 * @param {string} siteId
 * @param {string} id
 */
const logKey = (siteId, id) => ({ pk: sitePk(siteId), sk: `CARE_WORK#${id}` });
/**
 * @param {string} siteId
 * @param {string} id
 * @param {string} photoId
 */
const photoKey = (siteId, id, photoId) => ({
  pk: sitePk(siteId),
  sk: `CARE_UPLOAD#${id}#${photoId}`,
});
/**
 * @param {string} siteId
 * @param {string} id
 * @param {string} photoId
 */
const objectKey = (siteId, id, photoId) =>
  `care-work/${siteId}/${id}/${photoId}`;
/**
 * @param {any} event
 * @returns {Record<string, any> | null}
 */
function bodyOf(event) {
  try {
    const body = readJsonBody(event);
    return body && typeof body === "object" && !Array.isArray(body)
      ? body
      : null;
  } catch {
    return null;
  }
}
/**
 * @param {Record<string,string>} key
 */
async function read(key) {
  return (
    await ddb.send(
      new GetCommand({
        TableName: getConfig().dynamoTable,
        Key: key,
        ConsistentRead: true,
      }),
    )
  ).Item;
}
/**
 * @param {Record<string, any>} item
 */
function publicLog(item) {
  return {
    workId: item.workId,
    kind: item.kind,
    note: item.note,
    createdAt: item.createdAt,
    photoCount: item.photos.length,
    photos: item.photos.map((/** @type {any} */ photo) => ({
      photoId: photo.photoId,
      expiresAt: photo.expiresAt,
    })),
  };
}
/**
 * @param {unknown} error
 */
function conditionalFailure(error) {
  return (
    error instanceof Error &&
    [
      "ConditionalCheckFailedException",
      "TransactionCanceledException",
    ].includes(error.name)
  );
}

/** Reserve a private upload in the existing bucket; never enqueue analysis.
 * @param {any} event
 */
export async function presignCarePhoto(event) {
  const siteId = deriveSiteId(event);
  const actor = deriveActorId(event);
  const workId = event.pathParameters?.workId;
  const body = bodyOf(event);
  if (
    !UUID.test(workId || "") ||
    !body ||
    !TYPES.has(body.contentType) ||
    !Number.isInteger(body.contentLength) ||
    body.contentLength <= 0 ||
    body.contentLength > MAX_BYTES
  )
    return jsonResponse(400, { error: "invalid_photo" });
  const { dynamoTable: tableName, uploadBucket } = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const day = new Date().toISOString().slice(0, 10);
  const photoId = body.photoId || randomUUID();
  if (!UUID.test(photoId)) return jsonResponse(400, { error: "invalid_photo" });
  const s3Key = objectKey(siteId, workId, photoId);
  const expiresAt = now + DAY;
  const bytes = body.contentLength;
  let reservationExpiry = expiresAt;
  // Optimistic per-work accounting counts only live reservations, independently
  // of DynamoDB's asynchronous TTL deletion. Daily abuse quotas remain charged.
  for (let attempt = 0; attempt < 4; attempt++) {
    const [reservation, submitted] = await Promise.all([
      read(photoKey(siteId, workId, photoId)),
      read(logKey(siteId, workId)),
    ]);
    if (submitted) return jsonResponse(409, { error: "work_already_logged" });
    if (reservation) {
      if (
        reservation.createdBy !== actor ||
        reservation.contentType !== body.contentType ||
        reservation.contentLength !== bytes
      )
        return jsonResponse(409, { error: "upload_unavailable" });
      if (reservation.expiresAt <= now)
        return jsonResponse(410, { error: "upload_expired", photoId });
      reservationExpiry = reservation.expiresAt;
      break;
    }
    const budgetKey = { pk: sitePk(siteId), sk: `CARE_QUOTA#${workId}` };
    const budget = await read(budgetKey);
    const reservations = Object.fromEntries(
      Object.entries(budget?.reservations || {}).filter(
        ([, value]) => value.expiresAt > now,
      ),
    );
    // Preserve any pre-upgrade accounting until its own reservation window ends.
    const legacy =
      budget?.legacy ||
      (budget && !budget.revision
        ? {
            count: budget.reservedCount || 0,
            bytes: budget.reservedBytes || 0,
            expiresAt: budget.expiresAt,
          }
        : null);
    const legacyActive = legacy?.expiresAt > now;
    const count =
      Object.keys(reservations).length + (legacyActive ? legacy.count : 0);
    const total =
      Object.values(reservations).reduce((sum, value) => sum + value.bytes, 0) +
      (legacyActive ? legacy.bytes : 0);
    if (count >= 5 || total + bytes > MAX_TOTAL)
      return jsonResponse(409, { error: "photo_limit" });
    reservations[photoId] = { bytes, expiresAt };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: tableName,
                Key: logKey(siteId, workId),
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...photoKey(siteId, workId, photoId),
                  type: "careUpload",
                  createdBy: actor,
                  contentType: body.contentType,
                  contentLength: bytes,
                  createdAt: now,
                  expiresAt,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: tableName,
                Item: {
                  ...budgetKey,
                  reservations,
                  ...(legacyActive ? { legacy } : {}),
                  revision: randomUUID(),
                  expiresAt,
                },
                ConditionExpression: budget
                  ? budget.revision
                    ? "revision = :revision"
                    : "expiresAt = :expiry AND reservedCount = :count AND reservedBytes = :bytes AND attribute_not_exists(revision)"
                  : "attribute_not_exists(pk)",
                ...(budget
                  ? {
                      ExpressionAttributeValues: budget.revision
                        ? { ":revision": budget.revision }
                        : {
                            ":expiry": budget.expiresAt,
                            ":count": budget.reservedCount,
                            ":bytes": budget.reservedBytes,
                          },
                    }
                  : {}),
              },
            },
            quotaUpdate({
              tableName,
              key: {
                pk: sitePk(siteId),
                sk: `MEDIA_QUOTA#${day}#DEVICE#${actor}`,
              },
              maxBytes: MAX_DEVICE_DAILY_BYTES,
              maxCount: MAX_DEVICE_DAILY_ARTIFACTS,
              bytes,
              countField: "reservedCount",
              expiresAt,
            }),
          ],
        }),
      );
      break;
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      // Re-read after a racing reservation: an identical retry reuses the
      // winner without charging any quota twice.
      if (attempt === 3)
        return jsonResponse(409, { error: "upload_unavailable" });
    }
  }
  return jsonResponse(200, {
    photoId,
    expiresAt: reservationExpiry,
    uploadUrl: await presignPut({
      bucket: uploadBucket,
      key: s3Key,
      contentType: body.contentType,
      contentLength: bytes,
      tagging: "state=pending",
      expiresIn: 300,
    }),
    uploadHeaders: { "content-type": body.contentType, "if-none-match": "*" },
  });
}

/** Create once. Replays return the same log; changed payloads cannot edit it.
 * @param {any} event
 */
export async function createCareWork(event) {
  const siteId = deriveSiteId(event);
  const actor = deriveActorId(event);
  const body = bodyOf(event);
  if (
    !body ||
    !UUID.test(body.workId || "") ||
    !CARE_WORK_TYPES.has(body.kind) ||
    typeof body.note !== "string" ||
    body.note.length > 4000 ||
    (body.kind === "other" && !body.note.trim()) ||
    !Array.isArray(body.photoIds) ||
    body.photoIds.length > 5 ||
    body.photoIds.some(
      (/** @type {unknown} */ id) => typeof id !== "string" || !UUID.test(id),
    ) ||
    new Set(body.photoIds).size !== body.photoIds.length
  )
    return jsonResponse(400, { error: "invalid_care_work" });
  const { workId, kind } = body;
  const note = body.note.trim();
  const photoIds = [...body.photoIds].sort();
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ kind, note, photoIds, actor }))
    .digest("hex");
  const existing = await read(logKey(siteId, workId));
  if (existing && existing.expiresAt <= Date.now() / 1000)
    return jsonResponse(410, { error: "work_expired" });
  if (existing)
    return existing.fingerprint === fingerprint
      ? jsonResponse(200, { work: publicLog(existing) })
      : jsonResponse(409, { error: "work_already_logged" });
  const { dynamoTable: tableName, uploadBucket } = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const photos = [];
  let total = 0;
  // Sequential reads/decodes bound API memory to one camera image at a time.
  for (const photoId of photoIds) {
    const reservation = await read(photoKey(siteId, workId, photoId));
    if (reservation && reservation.createdBy !== actor)
      return jsonResponse(400, { error: "invalid_photo" });
    if (!reservation || reservation.expiresAt <= now)
      return jsonResponse(400, { error: "photo_expired", photoId });
    total += reservation.contentLength;
    if (total > MAX_TOTAL) return jsonResponse(400, { error: "photo_limit" });
    const rawKey = objectKey(siteId, workId, photoId);
    try {
      const head = await headObject({ bucket: uploadBucket, key: rawKey });
      if (
        head.contentType !== reservation.contentType ||
        head.contentLength !== reservation.contentLength ||
        head.metadata?.["declared-bytes"] !== String(reservation.contentLength)
      )
        return jsonResponse(400, { error: "photo_mismatch" });
      const raw = await getObjectBytes({ bucket: uploadBucket, key: rawKey });
      if (raw.bytes.length !== reservation.contentLength)
        return jsonResponse(400, { error: "photo_mismatch" });
      const normalized = await downscaleImage(
        raw.bytes,
        reservation.contentType,
      );
      // A separate, server-only key strips EXIF and is never writable with the
      // client's upload URL. Originals retain their one-day pending tag.
      const s3Key = `${rawKey}.jpg`;
      await putObject({
        bucket: uploadBucket,
        key: s3Key,
        body: normalized.bytes,
        contentType: normalized.contentType,
      });
      await setObjectTags({
        bucket: uploadBucket,
        key: s3Key,
        tags: { state: "active" },
      });
      photos.push({
        photoId,
        s3Key,
        expiresAt: reservation.createdAt + 30 * DAY,
      });
    } catch (error) {
      if (error instanceof DownscaleError)
        return jsonResponse(400, { error: "invalid_photo" });
      if (
        error instanceof Error &&
        ["NotFound", "NoSuchKey"].includes(error.name)
      )
        return jsonResponse(400, { error: "photo_missing" });
      throw error;
    }
  }
  const createdAt = new Date().toISOString();
  const item = {
    ...logKey(siteId, workId),
    type: "careWork",
    workId,
    kind,
    note,
    photos,
    createdAt,
    createdBy: actor,
    fingerprint,
    expiresAt: now + 365 * DAY,
    gsi1pk: `${sitePk(siteId)}#CARE_WORK`,
    gsi1sk: `${createdAt}#${workId}`,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          ...photoIds.map((photoId) => ({
            ConditionCheck: {
              TableName: tableName,
              Key: photoKey(siteId, workId, photoId),
              ConditionExpression: "createdBy = :actor AND expiresAt > :now",
              ExpressionAttributeValues: { ":actor": actor, ":now": now },
            },
          })),
        ],
      }),
    );
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const saved = await read(logKey(siteId, workId));
    if (saved?.fingerprint === fingerprint)
      return jsonResponse(200, { work: publicLog(saved) });
    return jsonResponse(409, { error: "work_not_saved" });
  }
  return jsonResponse(201, { work: publicLog(item) });
}

/**
 * @param {any} event
 */
export async function listCareWork(event) {
  const siteId = deriveSiteId(event);
  const partition = `${sitePk(siteId)}#CARE_WORK`;
  const token = event.queryStringParameters?.nextToken;
  let cursor;
  if (token) {
    try {
      if (typeof token !== "string" || token.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(token, "base64url").toString());
      if (
        cursor.pk !== sitePk(siteId) ||
        cursor.gsi1pk !== partition ||
        typeof cursor.sk !== "string" ||
        !cursor.sk.startsWith("CARE_WORK#") ||
        typeof cursor.gsi1sk !== "string" ||
        Object.keys(cursor).sort().join() !== "gsi1pk,gsi1sk,pk,sk"
      )
        throw new Error();
    } catch {
      return jsonResponse(400, { error: "invalid_cursor" });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const out = await ddb.send(
    new QueryCommand({
      TableName: getConfig().dynamoTable,
      IndexName: GSI1_NAME,
      KeyConditionExpression: "gsi1pk = :pk",
      FilterExpression: "expiresAt > :now",
      ExpressionAttributeValues: { ":pk": partition, ":now": now },
      ScanIndexForward: false,
      Limit: 50,
      ExclusiveStartKey: cursor,
    }),
  );
  return jsonResponse(200, {
    work: (out.Items || []).map(publicLog),
    nextToken: out.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64url")
      : null,
  });
}

/**
 * @param {any} event
 */
export async function getCareWork(event) {
  const siteId = deriveSiteId(event);
  const workId = event.pathParameters?.workId;
  if (!UUID.test(workId || ""))
    return jsonResponse(400, { error: "invalid_work_id" });
  const item = await read(logKey(siteId, workId));
  if (!item || item.expiresAt <= Date.now() / 1000)
    return jsonResponse(404, { error: "work_not_found" });
  return jsonResponse(200, { work: publicLog(item) });
}

/** Only signed, Site-scoped submitted media is readable.
 * @param {any} event
 */
export async function getCarePhoto(event) {
  const siteId = deriveSiteId(event);
  const { workId, photoId } = event.pathParameters || {};
  if (!UUID.test(workId || "") || !UUID.test(photoId || ""))
    return jsonResponse(400, { error: "invalid_photo" });
  const item = await read(logKey(siteId, workId));
  if (!item || item.expiresAt <= Date.now() / 1000)
    return jsonResponse(404, { error: "work_not_found" });
  const photo = item.photos.find(
    (/** @type {any} */ entry) => entry.photoId === photoId,
  );
  if (!photo || photo.s3Key !== `${objectKey(siteId, workId, photoId)}.jpg`)
    return jsonResponse(404, { error: "photo_not_found" });
  const remaining = Math.floor(photo.expiresAt - Date.now() / 1000);
  if (remaining <= 0) return jsonResponse(410, { error: "photo_expired" });
  try {
    await headObject({ bucket: getConfig().uploadBucket, key: photo.s3Key });
  } catch (error) {
    if (
      error instanceof Error &&
      ["NotFound", "NoSuchKey"].includes(error.name)
    )
      return jsonResponse(410, { error: "photo_expired" });
    throw error;
  }
  return jsonResponse(200, {
    downloadUrl: await presignGet({
      bucket: getConfig().uploadBucket,
      key: photo.s3Key,
      expiresIn: Math.min(300, remaining),
    }),
  });
}
