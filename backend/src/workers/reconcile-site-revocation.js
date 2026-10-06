import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";

/**
 * Reconcile display and refresh records after an emergency operation has
 * already invalidated the Site generation.
 * @type {import("aws-lambda").SQSHandler}
 */
export const handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    if (message.type !== "reconcile_site_revocation") {
      throw new Error("Unsupported revocation message");
    }
    await reconcileSite(message);
  }
};

/** @param {{operationId:string, operationPk:string, siteId:string, startedAt:string, actor:string}} message */
async function reconcileSite(message) {
  const tableName = getDynamoTableName();
  const [bindings, legacyDevices] = await Promise.all([
    queryAll(tableName, message.siteId, "DEVICE_BINDING#"),
    queryAll(tableName, message.siteId, "DEVICE#"),
  ]);
  const canonicalIds = new Set(bindings.map((binding) => binding.bindingId));
  const activeBindings = bindings.filter(
    (binding) => binding.status !== "revoked",
  );
  const legacyOnly = legacyDevices.filter(
    (device) =>
      !canonicalIds.has(device.bindingId ?? device.deviceId) &&
      device.status !== "revoked",
  );
  const now = new Date().toISOString();
  const results = await Promise.allSettled([
    ...activeBindings.map((binding) =>
      revokeBinding(tableName, binding, now, message.actor),
    ),
    ...legacyOnly.map((device) =>
      revokeLegacyDevice(tableName, message.siteId, device, now, message.actor),
    ),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      `Failed to reconcile ${failures.length} device records`,
    );
  }
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: message.operationPk,
                sk: `SITE#${message.siteId}`,
                type: "revocationOperationSiteResult",
                operationId: message.operationId,
                siteId: message.siteId,
                status: "complete",
                reconciledCount: results.length,
                failedCount: 0,
                completedAt: now,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk: message.operationPk, sk: "#META" },
              UpdateExpression:
                "ADD completedSiteCount :one SET updatedAt = :now",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeValues: { ":one": 1, ":now": now },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: {
                pk: `SITE#${message.siteId}`,
                sk: `REVOCATION_OPERATION#${message.startedAt}#${message.operationId}`,
              },
              UpdateExpression:
                "SET #status = :status, completedAt = :now, failedCount = :failed, reconciledCount = :reconciled",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": "complete",
                ":now": now,
                ":failed": 0,
                ":reconciled": results.length,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
    await finalizeOperationIfReady(tableName, message.operationPk);
    return;
  }
  await finalizeOperationIfReady(tableName, message.operationPk);
}

/** @param {string} tableName @param {Record<string, any>} binding @param {string} now @param {string} actor */
async function revokeBinding(tableName, binding, now, actor) {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: bindingItems(tableName, binding, now, actor),
      }),
    );
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
    const current = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: binding.pk, sk: binding.sk },
        ConsistentRead: true,
      }),
    );
    if (current.Item?.status !== "revoked") throw error;
  }
}

/** @param {string} tableName @param {string} siteId @param {Record<string, any>} device @param {string} now @param {string} actor */
async function revokeLegacyDevice(tableName, siteId, device, now, actor) {
  const key = { pk: `SITE#${siteId}`, sk: device.sk };
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression:
          "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedReason = :reason, revokedBy = :actor, tokenGeneration = :next",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":revoked": "revoked",
          ":reason": "emergency_multi_site_revocation",
          ":actor": actor,
          ":now": now,
          ":next": Number(device.tokenGeneration ?? 0) + 1,
        },
      }),
    );
  } catch (error) {
    if (!isConditionalConflict(error)) throw error;
    const current = await ddb.send(
      new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
    );
    if (current.Item?.status !== "revoked") throw error;
  }
}

/** @param {string} tableName @param {string} operationPk */
async function finalizeOperationIfReady(tableName, operationPk) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: operationPk, sk: "#META" },
      ConsistentRead: true,
    }),
  );
  const operation = result.Item;
  if (!operation) return;
  const queued = Number(operation.queuedSiteCount ?? 0);
  const completed = Number(operation.completedSiteCount ?? 0);
  const partial = Number(operation.partialSiteCount ?? 0);
  if (!queued || completed + partial < queued) return;
  const status =
    Number(operation.enqueueFailedCount ?? 0) || partial
      ? "partial"
      : "complete";
  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: operationPk, sk: "#META" },
      UpdateExpression: "SET #status = :status, completedAt = :now",
      ConditionExpression:
        "completedSiteCount = :completed AND partialSiteCount = :partial",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":now": new Date().toISOString(),
        ":completed": completed,
        ":partial": partial,
      },
    }),
  );
}

/** @param {string} tableName @param {Record<string, any>} binding @param {string} now @param {string} actor */
function bindingItems(tableName, binding, now, actor) {
  const bindingId = String(binding.bindingId);
  const next = Number(binding.tokenGeneration ?? 0) + 1;
  return [
    revokeUpdate(tableName, binding.pk, binding.sk, next, now, actor),
    revokeUpdate(
      tableName,
      `SITE#${binding.siteId}`,
      `DEVICE#${bindingId}`,
      next,
      now,
      actor,
    ),
    {
      Update: {
        TableName: tableName,
        Key: {
          pk: `PHYSICAL_DEVICE#${binding.physicalDeviceId}`,
          sk: `BINDING#${bindingId}`,
        },
        UpdateExpression:
          "SET #status = :revoked, revokedAt = :now, updatedAt = :now",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":revoked": "revoked", ":now": now },
      },
    },
  ];
}

/** @param {string} tableName @param {string} pk @param {string} sk @param {number} next @param {string} now @param {string} actor */
function revokeUpdate(tableName, pk, sk, next, now, actor) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedReason = :reason, revokedBy = :actor, tokenGeneration = :next",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":reason": "emergency_multi_site_revocation",
        ":actor": actor,
        ":now": now,
        ":next": next,
      },
    },
  };
}

/** @param {string} tableName @param {string} siteId @param {string} prefix */
async function queryAll(tableName, siteId, prefix) {
  const items = [];
  let cursor;
  do {
    const result =
      /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */ (
        await ddb.send(
          new QueryCommand({
            TableName: tableName,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": `SITE#${siteId}`,
              ":prefix": prefix,
            },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        )
      );
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items;
}

/** @param {unknown} error */
function isConditionalConflict(error) {
  return (
    error instanceof Error &&
    [
      "ConditionalCheckFailedException",
      "TransactionCanceledException",
    ].includes(error.name)
  );
}
