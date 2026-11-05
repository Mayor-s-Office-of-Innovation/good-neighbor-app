// Lookup expiry is operational TTL (epoch seconds); grant expiry stays ISO.
export const ENROLLMENT_RETENTION_SECONDS = 30 * 86400;
/** @param {string} at */
export function enrollmentLookupExpiry(at) {
  return Math.floor(Date.parse(at) / 1000) + ENROLLMENT_RETENTION_SECONDS;
}

/** Retire a credential without losing the canonical grant reference or error reason.
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
