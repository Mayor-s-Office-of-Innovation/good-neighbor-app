import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { adminOnly } from "../lib/admin-auth.js";

const MAX_SELECTED_BINDINGS = 20;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const revokeSelectedDeviceBindings = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const bindingIds = uniqueIds(body.bindingIds);
    if (
      !Array.isArray(body.bindingIds) ||
      !bindingIds.length ||
      bindingIds.length !== body.bindingIds.length ||
      bindingIds.length > MAX_SELECTED_BINDINGS
    ) {
      return jsonResponse(400, { error: "invalid_binding_selection" });
    }
    const tableName = getDynamoTableName();
    const bindings = await Promise.all(
      bindingIds.map((bindingId) => getBinding(tableName, siteId, bindingId)),
    );
    if (bindings.some((binding) => !binding)) {
      return jsonResponse(404, { error: "device_binding_not_found" });
    }
    /** @type {Array<Record<string, any>>} */
    const active = [];
    for (const binding of bindings) {
      if (binding && binding.status !== "revoked") active.push(binding);
    }
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const actor = actorId(event);
    /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */
    const items = active.flatMap((binding) =>
      bindingRevocationItems(tableName, binding, now, actor),
    );
    items.push(
      transactionPut(tableName, {
        pk: `SITE#${siteId}`,
        sk: `REVOCATION_OPERATION#${now}#${operationId}`,
        type: "revocationOperation",
        operationId,
        scope: "selected_bindings",
        siteId,
        requestedBindingIds: bindingIds,
        affectedCount: active.length,
        alreadyRevokedCount: bindings.length - active.length,
        status: "complete",
        actor,
        createdAt: now,
        completedAt: now,
      }),
      transactionPut(tableName, {
        pk: `SITE#${siteId}`,
        sk: `AUDIT#${now}#${randomUUID()}`,
        type: "siteAuditEvent",
        eventType: "selected_device_bindings_revoked",
        siteId,
        operationId,
        bindingIds,
        affectedCount: active.length,
        actor,
        createdAt: now,
      }),
    );
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, { error: "device_revocation_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      operationId,
      status: "complete",
      affectedCount: active.length,
      alreadyRevokedCount: bindings.length - active.length,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const revokeAllSiteDeviceBindings = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const tableName = getDynamoTableName();
    const siteResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    const site = siteResult.Item;
    if (!site) return jsonResponse(404, { error: "site_not_found" });
    if (String(body.confirmation ?? "") !== String(site.name)) {
      return jsonResponse(400, { error: "confirmation_mismatch" });
    }
    const [bindings, legacyDevices] = await Promise.all([
      queryAll(tableName, siteId, "DEVICE_BINDING#"),
      queryAll(tableName, siteId, "DEVICE#"),
    ]);
    const operationId = randomUUID();
    const now = new Date().toISOString();
    const actor = actorId(event);
    const nextSiteGeneration = Number(site.siteCredentialGeneration ?? 0) + 1;
    const canonicalIds = new Set(bindings.map((binding) => binding.bindingId));
    const legacyOnly = legacyDevices.filter(
      (device) =>
        !canonicalIds.has(device.bindingId ?? device.deviceId) &&
        device.status !== "revoked",
    );
    const requestedCount = bindings.length + legacyOnly.length;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName,
                Key: { pk: `SITE#${siteId}`, sk: "#META" },
                UpdateExpression:
                  "SET siteCredentialGeneration = :next, updatedAt = :now",
                ConditionExpression:
                  "attribute_exists(pk) AND (attribute_not_exists(siteCredentialGeneration) OR siteCredentialGeneration = :current)",
                ExpressionAttributeValues: {
                  ":current": Number(site.siteCredentialGeneration ?? 0),
                  ":next": nextSiteGeneration,
                  ":now": now,
                },
              },
            },
            transactionPut(tableName, {
              pk: `SITE#${siteId}`,
              sk: `REVOCATION_OPERATION#${now}#${operationId}`,
              type: "revocationOperation",
              operationId,
              scope: "site",
              siteId,
              siteCredentialGeneration: nextSiteGeneration,
              requestedCount,
              status: "applying",
              actor,
              createdAt: now,
            }),
            transactionPut(tableName, {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "site_device_bindings_revoked",
              siteId,
              operationId,
              siteCredentialGeneration: nextSiteGeneration,
              requestedCount,
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, { error: "site_revocation_conflict" });
      }
      throw error;
    }

    const results = await Promise.allSettled([
      ...bindings
        .filter((binding) => binding.status !== "revoked")
        .map((binding) =>
          ddb.send(
            new TransactWriteCommand({
              TransactItems: bindingRevocationItems(
                tableName,
                binding,
                now,
                actor,
              ),
            }),
          ),
        ),
      ...legacyOnly.map((device) =>
        revokeLegacy(tableName, siteId, device, now, actor),
      ),
    ]);
    const failedCount = results.filter(
      (result) => result.status === "rejected",
    ).length;
    const completedAt = new Date().toISOString();
    const status = failedCount ? "partial" : "complete";
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${siteId}`,
          sk: `REVOCATION_OPERATION#${now}#${operationId}`,
        },
        UpdateExpression:
          "SET #status = :status, completedAt = :completedAt, failedCount = :failedCount, reconciledCount = :reconciledCount",
        ConditionExpression: "#status = :applying",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":applying": "applying",
          ":status": status,
          ":completedAt": completedAt,
          ":failedCount": failedCount,
          ":reconciledCount": results.length - failedCount,
        },
      }),
    );
    if (failedCount) {
      console.error(
        JSON.stringify({
          marker: "RevocationOperationPartial",
          level: "ERROR",
          operationId,
          siteId,
          failedCount,
        }),
      );
    }
    return jsonResponse(200, {
      operationId,
      status,
      affectedCount: requestedCount,
      failedCount,
      siteCredentialGeneration: nextSiteGeneration,
    });
  });

/** @param {unknown} value */
function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item ?? "").trim())
        .filter((item) => /^[A-Za-z0-9_-]{1,100}$/.test(item)),
    ),
  ];
}

/** @param {string} tableName @param {string} siteId @param {string} bindingId */
async function getBinding(tableName, siteId, bindingId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: `DEVICE_BINDING#${bindingId}` },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

/** @param {string} tableName @param {Record<string, any>} binding @param {string} now @param {string} actor */
function bindingRevocationItems(tableName, binding, now, actor) {
  const bindingId = String(binding.bindingId);
  const nextGeneration = Number(binding.tokenGeneration ?? 0) + 1;
  return [
    revokeUpdate(tableName, binding.pk, binding.sk, nextGeneration, now, actor),
    revokeUpdate(
      tableName,
      `SITE#${binding.siteId}`,
      `DEVICE#${bindingId}`,
      nextGeneration,
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

/** @param {string} tableName @param {string} pk @param {string} sk @param {number} nextGeneration @param {string} now @param {string} actor */
function revokeUpdate(tableName, pk, sk, nextGeneration, now, actor) {
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
        ":reason": "city_admin_revocation",
        ":actor": actor,
        ":now": now,
        ":next": nextGeneration,
      },
    },
  };
}

/** @param {string} tableName @param {string} siteId @param {Record<string, any>} device @param {string} now @param {string} actor */
function revokeLegacy(tableName, siteId, device, now, actor) {
  return ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: device.sk },
      UpdateExpression:
        "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedReason = :reason, revokedBy = :actor, tokenGeneration = if_not_exists(tokenGeneration, :zero) + :one",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":reason": "site_wide_revocation",
        ":actor": actor,
        ":now": now,
        ":zero": 0,
        ":one": 1,
      },
    }),
  );
}

/** @param {string} tableName @param {string} siteId @param {string} prefix */
async function queryAll(tableName, siteId, prefix) {
  const items = [];
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": prefix,
        },
        ExclusiveStartKey,
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** @param {string} tableName @param {Record<string, unknown>} Item */
function transactionPut(tableName, Item) {
  return {
    Put: {
      TableName: tableName,
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
function actorId(event) {
  return String(
    /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
      "central-admin",
  );
}

/** @param {unknown} error */
function isTransactionConflict(error) {
  return (
    error instanceof Error && error.name === "TransactionCanceledException"
  );
}
