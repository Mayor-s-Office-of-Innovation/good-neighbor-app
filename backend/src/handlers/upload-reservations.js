import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";

/**
 * @typedef {object} UploadReservation
 * @property {string} pk
 * @property {string} kind
 * @property {string} parentId
 * @property {string} createdBy
 * @property {string} artifactId
 * @property {string} s3Key
 * @property {string} contentType
 * @property {number} contentLength
 * @property {string} createdAt
 * @property {number} [renewUntil]
 * @property {number} [expiresAt]
 */

/**
 * @param {number} statusCode
 * @param {string} code
 * @returns {Error & {statusCode: number, code: string}} Safe public error.
 */
function unavailable(statusCode, code) {
  return Object.assign(new Error(code), { statusCode, code });
}

/**
 * Reserve once per client request, together with the caller's quota writes.
 * Legacy callers without a request ID keep their existing transaction shape.
 * @param {object} input
 * @param {unknown} input.requestId
 * @param {string} input.tableName
 * @param {UploadReservation} input.reservation
 * @param {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} input.writes
 * @param {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>[number]} input.parentGuard
 * @returns {Promise<UploadReservation>} Original reservation on replay.
 */
export async function reserveUpload({
  requestId,
  tableName,
  reservation,
  writes,
  parentGuard,
}) {
  if (requestId === undefined) {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
    return reservation;
  }
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
  )
    throw unavailable(400, "invalid_upload_request_id");
  const key = {
    pk: reservation.pk,
    sk: `UPLOAD_REQUEST#${reservation.kind}#${encodeURIComponent(reservation.parentId)}#${requestId}`,
  };
  // TTL retains expired mappings for another day. Expiry is enforced below,
  // never by waiting for asynchronous DynamoDB deletion.
  const renewUntil = Math.floor(
    (Date.parse(reservation.createdAt) + 86400000) / 1000,
  );
  const candidate = {
    ...reservation,
    ...key,
    type: "uploadRequest",
    renewUntil,
    expiresAt: renewUntil + 86400,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await ddb.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    const existing = /** @type {UploadReservation | undefined} */ (result.Item);
    if (existing) {
      if (
        existing.createdBy !== reservation.createdBy ||
        existing.contentType !== reservation.contentType ||
        existing.contentLength !== reservation.contentLength
      )
        throw unavailable(409, "upload_request_conflict");
      if (
        !Number.isFinite(existing.renewUntil) ||
        Number(existing.renewUntil) <= Math.floor(Date.now() / 1000)
      )
        throw unavailable(410, "upload_expired");
      // Revalidate the parent without touching quota counters or extending TTL.
      await ddb.send(
        new TransactWriteCommand({ TransactItems: [parentGuard] }),
      );
      return existing;
    }
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...writes,
            {
              Put: {
                TableName: tableName,
                Item: candidate,
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return candidate;
    } catch (error) {
      const reasons = /** @type {{CancellationReasons?: {Code?: string}[]}} */ (
        error
      )?.CancellationReasons;
      if (
        !(error instanceof Error) ||
        error.name !== "TransactionCanceledException"
      )
        throw error;
      // A competing retry may have created our mapping. Read its winner before
      // classifying any quota condition in the cancelled transaction.
      if (
        reasons?.[writes.length]?.Code === "ConditionalCheckFailed" ||
        reasons?.some((reason) => reason.Code === "TransactionConflict")
      ) {
        if (attempt < 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (attempt + 1) + Math.random() * 20),
          );
          continue;
        }
        throw unavailable(409, "upload_reservation_conflict");
      }
      throw error;
    }
  }
  throw unavailable(409, "upload_reservation_conflict");
}

/**
 * @param {unknown} error
 * @returns {number | undefined} HTTP status for known reservation failures.
 */
export function reservationStatus(error) {
  return /** @type {{statusCode?: number}} */ (error)?.statusCode;
}

/**
 * @param {UploadReservation} reservation
 * @returns {number} URL lifetime capped at the original 24-hour renewal deadline.
 */
export function uploadUrlLifetime(reservation) {
  if (reservation.renewUntil === undefined) return 300;
  const remaining = reservation.renewUntil - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw unavailable(410, "upload_expired");
  return Math.min(300, remaining);
}
