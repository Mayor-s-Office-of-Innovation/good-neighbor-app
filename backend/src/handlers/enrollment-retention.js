import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";

// Lookup expiry is operational TTL (epoch seconds); grant expiry stays ISO.
export const ENROLLMENT_RETENTION_SECONDS = 30 * 86400;
/** @param {string} at */
export function enrollmentLookupExpiry(at) {
  return Math.floor(Date.parse(at) / 1000) + ENROLLMENT_RETENTION_SECONDS;
}

/** Record credential use or cancellation without losing its canonical grant reference.
 * A redeemed lookup remains usable; the canonical grant controls validity.
 * @param {string} tableName @param {Record<string,any>} grant
 * @param {string} hash @param {"redeemed"|"cancelled"} status @param {string} at
 */
export function retireEnrollmentLookup(tableName, grant, hash, status, at) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: `ENROLLMENT_TOKEN#${hash}`, sk: "#META" },
      UpdateExpression:
        "SET #status = :status, retiredAt = :at, expiresAt = :retention",
      ConditionExpression: "grantId = :grantId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":grantId": grant.grantId,
        ":status": status,
        ":at": at,
        ":retention": enrollmentLookupExpiry(at),
      },
    },
  };
}

/** Remove only this invitation's singleton pointer. An older redeemed grant
 * may outlive its pointer from before reusable invitations were introduced.
 * Cancelling it must not delete a newer invitation's pointer.
 * @param {string} tableName @param {{pk:string,sk:string}} key @param {string} grantId
 */
export async function currentGrantDeletion(tableName, key, grantId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  return Item?.grantId === grantId
    ? [
        {
          Delete: {
            TableName: tableName,
            Key: key,
            ConditionExpression: "grantId = :grantId",
            ExpressionAttributeValues: { ":grantId": grantId },
          },
        },
      ]
    : [];
}
