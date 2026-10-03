import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { adminOnly } from "../lib/admin-auth.js";
import { emailHash, normalizeEmail } from "./setup-codes.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listManagerMemberships = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "MANAGER_MEMBERSHIP#",
        },
      }),
    );
    return jsonResponse(200, {
      memberships: (result.Items ?? []).filter(
        (item) => item.status === "active",
      ),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createManagerMembership = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const name = clean(body.name);
    const email = normalizeEmail(String(body.email ?? ""));
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
export const deactivateManagerMembership = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const membershipId = event.pathParameters?.membershipId ?? "";
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
      return jsonResponse(404, { error: "manager_membership_not_found" });
    }
    const now = new Date().toISOString();
    const actor = actorId(event);
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
            put(tableName, {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "manager_membership_deactivated",
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
        return jsonResponse(409, { error: "manager_membership_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, { deactivated: true, membershipId });
  });

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
