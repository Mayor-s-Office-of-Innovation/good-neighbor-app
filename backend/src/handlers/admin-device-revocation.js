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
const MAX_PHYSICAL_BINDINGS = 20;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const suspendDeviceBinding = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const bindingId = event.pathParameters?.bindingId ?? "";
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(siteId) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(bindingId)
    ) {
      return jsonResponse(400, { error: "invalid_device_binding" });
    }
    const reason = suspensionReason(body.reason);
    if (!reason)
      return jsonResponse(400, { error: "invalid_suspension_reason" });
    const tableName = getDynamoTableName();
    const binding = await getBinding(tableName, siteId, bindingId);
    if (!binding) {
      return suspendLegacyDevice(tableName, siteId, bindingId, reason, event);
    }
    if (binding.status === "revoked") {
      return jsonResponse(409, { error: "device_binding_already_revoked" });
    }
    if (binding.status === "suspended") {
      return jsonResponse(200, {
        binding: publicSuspendedBinding(binding),
        alreadySuspended: true,
      });
    }
    const now = new Date().toISOString();
    const actor = actorId(event);
    const nextGeneration = Number(binding.tokenGeneration ?? 0) + 1;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            suspensionUpdate(
              tableName,
              binding.pk,
              binding.sk,
              nextGeneration,
              now,
              actor,
              reason,
            ),
            suspensionUpdate(
              tableName,
              `SITE#${siteId}`,
              `DEVICE#${bindingId}`,
              nextGeneration,
              now,
              actor,
              reason,
            ),
            {
              Update: {
                TableName: tableName,
                Key: {
                  pk: `PHYSICAL_DEVICE#${binding.physicalDeviceId}`,
                  sk: `BINDING#${bindingId}`,
                },
                UpdateExpression:
                  "SET #status = :suspended, suspendedAt = :now, updatedAt = :now, suspendedReason = :reason",
                ConditionExpression:
                  "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":active": "active",
                  ":suspended": "suspended",
                  ":now": now,
                  ":reason": reason,
                },
              },
            },
            transactionPut(tableName, {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "device_binding_suspended",
              siteId,
              bindingId,
              physicalDeviceId: binding.physicalDeviceId,
              accessLevel: binding.accessLevel,
              reason,
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, { error: "device_suspension_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      binding: publicSuspendedBinding({
        ...binding,
        status: "suspended",
        tokenGeneration: nextGeneration,
        suspendedAt: now,
        suspendedBy: actor,
        suspendedReason: reason,
      }),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getPhysicalDeviceRevocationPreview = (event) =>
  adminOnly(event, async () => {
    const physicalDeviceId = event.pathParameters?.physicalDeviceId ?? "";
    const preview = await loadPhysicalDevicePreview(
      getDynamoTableName(),
      physicalDeviceId,
    );
    if (!preview)
      return jsonResponse(404, { error: "physical_device_not_found" });
    return jsonResponse(200, {
      physicalDevice: {
        physicalDeviceId: preview.physicalDeviceId,
        label: preview.label,
        status: preview.status,
        bindings: preview.bindings.map((entry) => ({
          bindingId: entry.binding.bindingId,
          siteId: entry.binding.siteId,
          siteName: entry.siteName,
          accessLevel: entry.binding.accessLevel,
          status: entry.binding.status,
        })),
      },
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const revokePhysicalDeviceEverywhere = (event) =>
  adminOnly(event, async (body) => {
    const physicalDeviceId = event.pathParameters?.physicalDeviceId ?? "";
    const tableName = getDynamoTableName();
    const preview = await loadPhysicalDevicePreview(
      tableName,
      physicalDeviceId,
    );
    if (!preview)
      return jsonResponse(404, { error: "physical_device_not_found" });
    if (String(body.confirmation ?? "") !== preview.label) {
      return jsonResponse(400, { error: "confirmation_mismatch" });
    }
    if (preview.status === "revoked") {
      return jsonResponse(200, {
        status: "complete",
        affectedCount: 0,
        alreadyRevoked: true,
      });
    }
    if (preview.bindings.length > MAX_PHYSICAL_BINDINGS) {
      return jsonResponse(409, {
        error: "physical_device_binding_limit_exceeded",
      });
    }
    const now = new Date().toISOString();
    const operationId = randomUUID();
    const actor = actorId(event);
    /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */
    const items = [
      {
        Update: {
          TableName: tableName,
          Key: { pk: `PHYSICAL_DEVICE#${physicalDeviceId}`, sk: "#META" },
          UpdateExpression:
            "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedBy = :actor, revokedReason = :reason",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":revoked": "revoked",
            ":now": now,
            ":actor": actor,
            ":reason": "physical_device_revoked_everywhere",
          },
        },
      },
      ...preview.bindings.flatMap((entry) => [
        ...bindingRevocationItems(tableName, entry.binding, now, actor),
        transactionPut(tableName, {
          pk: `SITE#${entry.binding.siteId}`,
          sk: `AUDIT#${now}#${randomUUID()}`,
          type: "siteAuditEvent",
          eventType: "physical_device_revoked_everywhere",
          siteId: entry.binding.siteId,
          operationId,
          bindingId: entry.binding.bindingId,
          physicalDeviceId,
          actor,
          createdAt: now,
        }),
      ]),
      transactionPut(tableName, {
        pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
        sk: `REVOCATION_OPERATION#${now}#${operationId}`,
        type: "revocationOperation",
        operationId,
        scope: "physical_device",
        physicalDeviceId,
        affectedSiteIds: preview.bindings.map((entry) => entry.binding.siteId),
        affectedCount: preview.bindings.length,
        status: "complete",
        actor,
        createdAt: now,
        completedAt: now,
      }),
    ];
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, {
          error: "physical_device_revocation_conflict",
        });
      }
      throw error;
    }
    return jsonResponse(200, {
      operationId,
      status: "complete",
      affectedCount: preview.bindings.length,
      affectedSites: preview.bindings.map((entry) => ({
        siteId: entry.binding.siteId,
        siteName: entry.siteName,
      })),
    });
  });

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

/** @param {string} tableName @param {string} physicalDeviceId */
async function loadPhysicalDevicePreview(tableName, physicalDeviceId) {
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(physicalDeviceId)) return null;
  const [physicalResult, pointersResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PHYSICAL_DEVICE#${physicalDeviceId}`, sk: "#META" },
        ConsistentRead: true,
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: tableName,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PHYSICAL_DEVICE#${physicalDeviceId}`,
          ":prefix": "BINDING#",
        },
      }),
    ),
  ]);
  const physical = physicalResult.Item;
  if (!physical) return null;
  const resolved = await Promise.all(
    (pointersResult.Items ?? [])
      .filter((pointer) => pointer.status !== "revoked")
      .map(async (pointer) => {
        const [bindingResult, siteResult] = await Promise.all([
          ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                pk: `SITE#${pointer.siteId}`,
                sk: `DEVICE_BINDING#${pointer.bindingId}`,
              },
              ConsistentRead: true,
            }),
          ),
          ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: { pk: `SITE#${pointer.siteId}`, sk: "#META" },
            }),
          ),
        ]);
        const binding = bindingResult.Item;
        if (
          !binding ||
          binding.status === "revoked" ||
          binding.physicalDeviceId !== physicalDeviceId
        ) {
          return null;
        }
        return {
          binding,
          siteName: String(siteResult.Item?.name ?? pointer.siteId),
        };
      }),
  );
  /** @type {Array<{binding:Record<string, any>, siteName:string}>} */
  const bindings = [];
  for (const entry of resolved) {
    if (entry) bindings.push(entry);
  }
  return {
    physicalDeviceId,
    label: String(physical.label || "Unnamed device"),
    status: String(physical.status || "active"),
    bindings,
  };
}

/** @param {unknown} value */
function suspensionReason(value) {
  const reason = String(value ?? "");
  return [
    "security_review",
    "lost_or_unaccounted_device",
    "refresh_replay",
    "policy_violation",
  ].includes(reason)
    ? reason
    : "";
}

/** @param {string} tableName @param {string} siteId @param {string} deviceId @param {string} reason @param {import("aws-lambda").APIGatewayProxyEventV2} event */
async function suspendLegacyDevice(tableName, siteId, deviceId, reason, event) {
  const now = new Date().toISOString();
  const actor = actorId(event);
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${deviceId}` },
        UpdateExpression:
          "SET #status = :suspended, suspendedAt = :now, updatedAt = :now, suspendedReason = :reason, suspendedBy = :actor, tokenGeneration = if_not_exists(tokenGeneration, :zero) + :one",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":active": "active",
          ":suspended": "suspended",
          ":reason": reason,
          ":actor": actor,
          ":now": now,
          ":zero": 0,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, {
      binding: publicSuspendedBinding({ ...result.Attributes, legacy: true }),
    });
  } catch (error) {
    if (isTransactionConflict(error)) {
      return jsonResponse(409, { error: "device_suspension_conflict" });
    }
    throw error;
  }
}

/** @param {string} tableName @param {string} pk @param {string} sk @param {number} nextGeneration @param {string} now @param {string} actor @param {string} reason */
function suspensionUpdate(
  tableName,
  pk,
  sk,
  nextGeneration,
  now,
  actor,
  reason,
) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        "SET #status = :suspended, suspendedAt = :now, updatedAt = :now, suspendedReason = :reason, suspendedBy = :actor, tokenGeneration = :next",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "active",
        ":suspended": "suspended",
        ":reason": reason,
        ":actor": actor,
        ":now": now,
        ":next": nextGeneration,
      },
    },
  };
}

/** @param {Record<string, any>} binding */
function publicSuspendedBinding(binding) {
  return {
    bindingId: binding.bindingId ?? binding.deviceId,
    deviceId: binding.bindingId ?? binding.deviceId,
    physicalDeviceId: binding.physicalDeviceId,
    siteId: binding.siteId,
    label: binding.label,
    accessLevel:
      binding.accessLevel === "admin" ? "manager" : binding.accessLevel,
    status: binding.status,
    tokenGeneration: binding.tokenGeneration,
    suspendedAt: binding.suspendedAt,
    suspendedReason: binding.suspendedReason,
    legacy: binding.legacy === true,
  };
}

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
