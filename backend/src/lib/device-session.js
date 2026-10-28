// The session rotation on a DEVICE# or DEVICE_BINDING# row: bump the
// generation, store the new refresh jti, touch lastSeenAt — conditioned on the
// generation observed in the read so two concurrent rotations cannot both
// win. Shared by binding selection and retryable primary refresh (ADR 0020).
// The latter adds its old-JTI guard and encrypted receipt to the same update.
// Legacy refresh retains its own UpdateCommand in devices.js `mintSession`.
//
// A missing `status` is accepted: legacy setup-code devices never had one,
// and the authorizer treats absence as active (lib/device-liveness.js).

/**
 * One TransactWriteCommand item rotating `item`'s session.
 * @param {string} tableName
 * @param {Record<string, any>} item the row as read (pk, sk, tokenGeneration)
 * @param {{ generation: number, refreshJti: string, now: string, expectHandoffGrantId?: string, clearHandoffGrant?: boolean }} rotation
 *   `expectHandoffGrantId` additionally requires the row's pending handoff
 *   pointer to name that grant; `clearHandoffGrant` removes the pointer.
 */
export function sessionRotationItem(
  tableName,
  item,
  { generation, refreshJti, now, expectHandoffGrantId, clearHandoffGrant },
) {
  const conditions = [
    "(attribute_not_exists(#status) OR #status = :active)",
    "tokenGeneration = :current",
  ];
  /** @type {Record<string, unknown>} */
  const values = {
    ":active": "active",
    ":current": Number(item.tokenGeneration ?? 0),
    ":next": generation,
    ":jti": refreshJti,
    ":now": now,
  };
  if (expectHandoffGrantId !== undefined) {
    conditions.push("handoffGrantId = :grant");
    values[":grant"] = expectHandoffGrantId;
  }
  return {
    Update: {
      TableName: tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression:
        "SET tokenGeneration = :next, refreshJti = :jti, lastSeenAt = :now, primaryLastSeenAt = :now, primarySessionStatus = :active" +
        (item.primarySessionStatus === "signed_out"
          ? ", sessionStartGeneration = :next"
          : "") +
        (clearHandoffGrant ? " REMOVE handoffGrantId" : ""),
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: values,
    },
  };
}
