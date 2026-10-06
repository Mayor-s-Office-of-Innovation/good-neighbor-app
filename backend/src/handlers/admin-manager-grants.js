import { createHash, randomBytes, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { sendManagerEnrollmentEmail } from "../integrations/email.js";
import { adminOnly } from "../lib/admin-auth.js";

const MANAGER_GRANT_TTL_MS = 15 * 60 * 1000;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listManagerGrants = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "MANAGER_GRANT#",
        },
        ScanIndexForward: false,
      }),
    );
    const now = new Date().toISOString();
    return jsonResponse(200, {
      grants: (result.Items ?? []).map((item) => publicGrant(item, now)),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createManagerGrant = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const membershipId = String(body.membershipId ?? "").trim();
    if (!membershipId) {
      return jsonResponse(400, { error: "manager_membership_required" });
    }
    const tableName = getDynamoTableName();
    const [siteResult, membershipResult, grantsResult, currentGrantResult] =
      await Promise.all([
        ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: `SITE#${siteId}`, sk: "#META" },
          }),
        ),
        ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: `SITE#${siteId}`,
              sk: `MANAGER_MEMBERSHIP#${membershipId}`,
            },
          }),
        ),
        ddb.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": `SITE#${siteId}`,
              ":prefix": "MANAGER_GRANT#",
            },
            ScanIndexForward: false,
          }),
        ),
        ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: {
              pk: `SITE#${siteId}`,
              sk: `MANAGER_GRANT_CURRENT#${membershipId}`,
            },
            ConsistentRead: true,
          }),
        ),
      ]);
    const site = siteResult.Item;
    const membership = membershipResult.Item;
    if (!site || site.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    if (!membership || membership.status !== "active") {
      return jsonResponse(404, { error: "manager_membership_not_found" });
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + MANAGER_GRANT_TTL_MS,
    ).toISOString();
    const grantId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const actor = actorId(event);
    const enrollmentUrl = enrollmentLink(
      process.env.PROVIDER_APP_URL ?? "http://localhost:5173/",
      grantId,
      token,
    );
    const grant = {
      pk: `SITE#${siteId}`,
      sk: `MANAGER_GRANT#${nowIso}#${grantId}`,
      type: "enrollmentGrant",
      entityType: "ENROLLMENT_GRANT",
      grantId,
      membershipId,
      siteId,
      accessLevel: "manager",
      tokenHash,
      status: "pending",
      deliveryStatus: "queued",
      issuedTo: membership.email,
      issuedBy: actor,
      createdAt: nowIso,
      expiresAt,
    };
    const currentGrant = currentGrantResult.Item;
    const replaced =
      currentGrant && String(currentGrant.expiresAt) > nowIso
        ? {
            ...currentGrant,
            pk: currentGrant.grantPk,
            sk: currentGrant.grantSk,
          }
        : (grantsResult.Items ?? []).find(
            (item) =>
              item.membershipId === membershipId &&
              item.issuedBy !== "manager-email-recovery" &&
              item.status === "pending" &&
              item.expiresAt > nowIso,
          );
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const transactItems = [
      put(tableName, grant),
      put(tableName, {
        pk: `ENROLLMENT_TOKEN#${tokenHash}`,
        sk: "#META",
        type: "enrollmentGrantToken",
        grantPk: grant.pk,
        grantSk: grant.sk,
        grantId,
        siteId,
        expiresAt,
      }),
      put(tableName, {
        pk: `SITE#${siteId}`,
        sk: `AUDIT#${nowIso}#${randomUUID()}`,
        type: "siteAuditEvent",
        eventType: "manager_grant_issued",
        siteId,
        membershipId,
        grantId,
        ...(replaced ? { replacedGrantId: replaced.grantId } : {}),
        actor,
        createdAt: nowIso,
      }),
      {
        Put: {
          TableName: tableName,
          Item: {
            pk: `SITE#${siteId}`,
            sk: `MANAGER_GRANT_CURRENT#${membershipId}`,
            type: "currentManagerEnrollmentGrant",
            siteId,
            membershipId,
            grantId,
            grantPk: grant.pk,
            grantSk: grant.sk,
            tokenHash,
            expiresAt,
            updatedAt: nowIso,
          },
          ConditionExpression: replaced
            ? "attribute_not_exists(pk) OR grantId = :replacedGrantId"
            : "attribute_not_exists(pk) OR expiresAt <= :now",
          ExpressionAttributeValues: replaced
            ? { ":replacedGrantId": replaced.grantId }
            : { ":now": nowIso },
        },
      },
    ];
    if (replaced) {
      transactItems.push(
        {
          Update: {
            TableName: tableName,
            Key: { pk: replaced.pk, sk: replaced.sk },
            UpdateExpression:
              "SET #status = :replaced, replacedAt = :now, replacedByGrantId = :grantId",
            ConditionExpression: "#status = :pending",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":pending": "pending",
              ":replaced": "replaced",
              ":now": nowIso,
              ":grantId": grantId,
            },
          },
        },
        {
          Delete: {
            TableName: tableName,
            Key: {
              pk: `ENROLLMENT_TOKEN#${replaced.tokenHash}`,
              sk: "#META",
            },
          },
        },
      );
    }
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "manager_grant_conflict" });
      }
      throw error;
    }

    let deliveryStatus = "accepted";
    let deliveryProvider = "ses";
    let messageId = "";
    try {
      const delivery = await sendManagerEnrollmentEmail({
        to: String(membership.email),
        managerName: String(membership.name),
        siteName: String(site.name),
        enrollmentUrl,
        expiresAt,
      });
      deliveryProvider = delivery.provider;
      messageId = delivery.messageId;
    } catch {
      deliveryStatus = "failed";
    }
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: grant.pk, sk: grant.sk },
        UpdateExpression:
          "SET deliveryStatus = :deliveryStatus, deliveryProvider = :provider, deliveryMessageId = :messageId, deliveryUpdatedAt = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deliveryStatus": deliveryStatus,
          ":provider": deliveryProvider,
          ":messageId": messageId,
          ":now": new Date().toISOString(),
          ":pending": "pending",
        },
      }),
    );
    return jsonResponse(201, {
      grant: publicGrant(
        { ...grant, deliveryStatus, deliveryProvider },
        nowIso,
      ),
      enrollmentUrl,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const cancelManagerGrant = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const grantId = event.pathParameters?.grantId ?? "";
    const tableName = getDynamoTableName();
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "MANAGER_GRANT#",
        },
      }),
    );
    const grant = (result.Items ?? []).find((item) => item.grantId === grantId);
    if (!grant || grant.status !== "pending") {
      return jsonResponse(404, { error: "manager_grant_not_found" });
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
                Key: { pk: grant.pk, sk: grant.sk },
                UpdateExpression:
                  "SET #status = :cancelled, cancelledAt = :now, cancelledBy = :actor",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":pending": "pending",
                  ":cancelled": "cancelled",
                  ":now": now,
                  ":actor": actor,
                },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: { pk: `ENROLLMENT_TOKEN#${grant.tokenHash}`, sk: "#META" },
              },
            },
            {
              Delete: {
                TableName: tableName,
                Key: {
                  pk: `SITE#${siteId}`,
                  sk: `${grant.issuedBy === "manager-email-recovery" ? "MANAGER_RECOVERY_GRANT_CURRENT" : "MANAGER_GRANT_CURRENT"}#${grant.membershipId}`,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) OR grantId = :grantId",
                ExpressionAttributeValues: { ":grantId": grantId },
              },
            },
            put(tableName, {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "manager_grant_cancelled",
              siteId,
              membershipId: grant.membershipId,
              grantId,
              actor,
              createdAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "manager_grant_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, { cancelled: true, grantId });
  });

/**
 * @param {Record<string, any>} item
 * @param {string} now
 * @returns {Record<string, unknown>}
 */
function publicGrant(item, now) {
  const status =
    item.status === "pending" && item.expiresAt <= now
      ? "expired"
      : item.status;
  return {
    grantId: item.grantId,
    membershipId: item.membershipId,
    siteId: item.siteId,
    accessLevel: "manager",
    status,
    deliveryStatus: item.deliveryStatus,
    deliveryProvider: item.deliveryProvider,
    securityNotificationStatus: item.securityNotificationStatus,
    securityNotificationProvider: item.securityNotificationProvider,
    securityNotificationUpdatedAt: item.securityNotificationUpdatedAt,
    issuedTo: item.issuedTo,
    issuedBy: item.issuedBy,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

/**
 * @param {string} appUrl
 * @param {string} grantId
 * @param {string} token
 * @returns {string}
 */
function enrollmentLink(appUrl, grantId, token) {
  const url = new URL(appUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("enrollment_grant", grantId);
  fragment.set("enrollment_token", token);
  url.hash = fragment.toString();
  return url.toString();
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
