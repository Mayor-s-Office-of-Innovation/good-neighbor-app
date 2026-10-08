import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { adminOnly, supervisorOnly } from "../lib/admin-auth.js";
import { emailHash, normalizeEmail } from "./setup-codes.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listManagerMemberships = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const tableName = getDynamoTableName();
    const [result, bindingsResult] = await Promise.all([
      ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `SITE#${siteId}`,
            ":prefix": "MANAGER_MEMBERSHIP#",
          },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `SITE#${siteId}`,
            ":prefix": "DEVICE_BINDING#",
          },
        }),
      ),
    ]);
    const bindingCounts = new Map();
    for (const binding of bindingsResult.Items ?? []) {
      if (binding.status !== "active" || !binding.membershipId) continue;
      bindingCounts.set(
        binding.membershipId,
        Number(bindingCounts.get(binding.membershipId) ?? 0) + 1,
      );
    }
    return jsonResponse(200, {
      memberships: (result.Items ?? [])
        .filter((item) => item.status === "active")
        .map((item) => ({
          ...item,
          activeBindingCount: Number(bindingCounts.get(item.membershipId) ?? 0),
        })),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createManagerMembership = (event) =>
  supervisorOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const name = clean(body.name);
    const email = normalizeEmail(String(body.email ?? ""));
    const programId = clean(body.programId);
    const userId = clean(body.userId);
    if (!name || name.length > 200) {
      return jsonResponse(400, { error: "invalid_manager_name" });
    }
    if (!isPlausibleEmail(email) || email.length > 320) {
      return jsonResponse(400, { error: "invalid_manager_email" });
    }
    const tableName = getDynamoTableName();
    const siteResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    if (!siteResult.Item || siteResult.Item.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const now = new Date().toISOString();
    const membershipId = randomUUID();
    const verifier = await emailHash(email);
    const actor = actorId(event);
    const membership = {
      pk: `SITE#${siteId}`,
      sk: `MANAGER_MEMBERSHIP#${membershipId}`,
      type: "managerMembership",
      entityType: "MANAGER_MEMBERSHIP",
      membershipId,
      siteId,
      ...(programId ? { programId } : {}),
      ...(userId ? { userId } : {}),
      name,
      email,
      emailHash: verifier,
      role: "manager",
      status: "active",
      generation: 1,
      createdAt: now,
      createdBy: actor,
      updatedAt: now,
      updatedBy: actor,
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            put(tableName, membership),
            put(tableName, {
              pk: `SITE#${siteId}`,
              sk: `MANAGER_EMAIL#${verifier}`,
              type: "managerMembershipEmail",
              membershipId,
              siteId,
              createdAt: now,
            }),
            put(tableName, {
              pk: `MANAGER_EMAIL#${verifier}`,
              sk: `SITE#${siteId}#MEMBERSHIP#${membershipId}`,
              type: "managerMembershipDirectory",
              membershipId,
              siteId,
              status: "active",
              createdAt: now,
            }),
            put(tableName, {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "manager_membership_created",
              siteId,
              membershipId,
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, { error: "manager_membership_exists" });
      }
      throw error;
    }
    return jsonResponse(201, { membership });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateManagerMembership = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const membershipId = event.pathParameters?.membershipId ?? "";
    const name = clean(body.name);
    const email = normalizeEmail(String(body.email ?? ""));
    if (!name || name.length > 200) {
      return jsonResponse(400, { error: "invalid_manager_name" });
    }
    if (!isPlausibleEmail(email) || email.length > 320) {
      return jsonResponse(400, { error: "invalid_manager_email" });
    }
    const tableName = getDynamoTableName();
    const currentResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${siteId}`,
          sk: `MANAGER_MEMBERSHIP#${membershipId}`,
        },
      }),
    );
    const current = currentResult.Item;
    if (!current || current.status !== "active") {
      return jsonResponse(404, { error: "manager_membership_not_found" });
    }
    const nextHash = await emailHash(email);
    const now = new Date().toISOString();
    const actor = actorId(event);
    const hashChanged = nextHash !== current.emailHash;
    const update = {
      Update: {
        TableName: tableName,
        Key: { pk: current.pk, sk: current.sk },
        UpdateExpression:
          "SET #name = :name, email = :email, emailHash = :emailHash, updatedAt = :now, updatedBy = :actor",
        ConditionExpression: "#status = :active",
        ExpressionAttributeNames: { "#name": "name", "#status": "status" },
        ExpressionAttributeValues: {
          ":name": name,
          ":email": email,
          ":emailHash": nextHash,
          ":now": now,
          ":actor": actor,
          ":active": "active",
        },
      },
    };
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [update];
    if (hashChanged) {
      items.push(
        {
          Delete: {
            TableName: tableName,
            Key: {
              pk: `SITE#${siteId}`,
              sk: `MANAGER_EMAIL#${current.emailHash}`,
            },
            ConditionExpression: "membershipId = :membershipId",
            ExpressionAttributeValues: { ":membershipId": membershipId },
          },
        },
        {
          Delete: {
            TableName: tableName,
            Key: {
              pk: `MANAGER_EMAIL#${current.emailHash}`,
              sk: `SITE#${siteId}#MEMBERSHIP#${membershipId}`,
            },
            ConditionExpression: "membershipId = :membershipId",
            ExpressionAttributeValues: { ":membershipId": membershipId },
          },
        },
        put(tableName, {
          pk: `SITE#${siteId}`,
          sk: `MANAGER_EMAIL#${nextHash}`,
          type: "managerMembershipEmail",
          membershipId,
          siteId,
          createdAt: now,
        }),
        put(tableName, {
          pk: `MANAGER_EMAIL#${nextHash}`,
          sk: `SITE#${siteId}#MEMBERSHIP#${membershipId}`,
          type: "managerMembershipDirectory",
          membershipId,
          siteId,
          status: "active",
          createdAt: now,
        }),
      );
    }
    items.push(
      put(tableName, {
        pk: `SITE#${siteId}`,
        sk: `AUDIT#${now}#${randomUUID()}`,
        type: "siteAuditEvent",
        eventType: "manager_membership_updated",
        siteId,
        membershipId,
        actor,
        createdAt: now,
      }),
    );
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, { error: "manager_membership_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      membership: {
        ...current,
        name,
        email,
        emailHash: nextHash,
        updatedAt: now,
        updatedBy: actor,
      },
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const deactivateManagerMembership = (event) =>
  supervisorOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const membershipId = event.pathParameters?.membershipId ?? "";
    const result = await deactivateManagerMembershipRecord({
      siteId,
      membershipId,
      actor: actorId(event),
    });
    if (!result) {
      return jsonResponse(404, { error: "manager_membership_not_found" });
    }
    if (result.error) {
      return jsonResponse(409, { error: result.error });
    }
    return jsonResponse(200, result);
  });

/**
 * Deactivate one manager membership and revoke its active manager bindings.
 * Returns null when the membership is already absent or inactive.
 * @param {{ siteId: string, membershipId: string, actor: string }} input
 */
export async function deactivateManagerMembershipRecord({
  siteId,
  membershipId,
  actor,
}) {
  const tableName = getDynamoTableName();
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: `SITE#${siteId}`,
        sk: `MANAGER_MEMBERSHIP#${membershipId}`,
      },
    }),
  );
  const membership = result.Item;
  if (!membership || membership.status !== "active") {
    return null;
  }
  const now = new Date().toISOString();
  const bindingsResult = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": "DEVICE_BINDING#",
      },
    }),
  );
  const bindings = (bindingsResult.Items ?? []).filter(
    (binding) =>
      binding.status === "active" &&
      binding.membershipId === membershipId &&
      binding.accessLevel === "manager",
  );
  if (bindings.length > 30) {
    return { error: "membership_binding_limit_exceeded" };
  }
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: membership.pk, sk: membership.sk },
              UpdateExpression:
                "SET #status = :inactive, generation = generation + :one, deactivatedAt = :now, deactivatedBy = :actor, updatedAt = :now, updatedBy = :actor",
              ConditionExpression: "#status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ":inactive": "inactive",
                ":one": 1,
                ":now": now,
                ":actor": actor,
              },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: {
                pk: `SITE#${siteId}`,
                sk: `MANAGER_EMAIL#${membership.emailHash}`,
              },
              ConditionExpression: "membershipId = :membershipId",
              ExpressionAttributeValues: { ":membershipId": membershipId },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: {
                pk: `MANAGER_EMAIL#${membership.emailHash}`,
                sk: `SITE#${siteId}#MEMBERSHIP#${membershipId}`,
              },
              ConditionExpression: "membershipId = :membershipId",
              ExpressionAttributeValues: { ":membershipId": membershipId },
            },
          },
          ...bindings.flatMap((binding) =>
            managerBindingRevocationItems(tableName, binding, now, actor),
          ),
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${now}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: "manager_membership_deactivated",
            siteId,
            membershipId,
            revokedBindingCount: bindings.length,
            actor,
            createdAt: now,
          }),
        ],
      }),
    );
  } catch (error) {
    if (isTransactionConflict(error)) {
      return { error: "manager_membership_conflict" };
    }
    throw error;
  }
  return {
    deactivated: true,
    membershipId,
    revokedBindingCount: bindings.length,
  };
}

/** @param {string} tableName @param {Record<string, any>} binding @param {string} now @param {string} actor */
function managerBindingRevocationItems(tableName, binding, now, actor) {
  const bindingId = String(binding.bindingId);
  const nextGeneration = Number(binding.tokenGeneration ?? 0) + 1;
  return [
    revokedBindingUpdate(
      tableName,
      binding.pk,
      binding.sk,
      nextGeneration,
      now,
      actor,
    ),
    revokedBindingUpdate(
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
function revokedBindingUpdate(tableName, pk, sk, nextGeneration, now, actor) {
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
        ":reason": "manager_membership_deactivated",
        ":actor": actor,
        ":now": now,
        ":next": nextGeneration,
      },
    },
  };
}

/**
 * @param {string} tableName
 * @param {Record<string, unknown>} Item
 * @returns {Record<string, unknown>}
 */
function put(tableName, Item) {
  return {
    Put: {
      TableName: tableName,
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {string}
 */
function actorId(event) {
  return String(
    /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
      "central-admin",
  );
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPlausibleEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransactionConflict(error) {
  return (
    error instanceof Error && error.name === "TransactionCanceledException"
  );
}
