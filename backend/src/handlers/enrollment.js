import { createHash, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { mintAccessToken, mintRefreshToken } from "../lib/device-token.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const ABSOLUTE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const INACTIVITY_LIMIT_DAYS = 60;
const INVALID_GRANT = { error: "invalid_enrollment_grant" };

/**
 * Redeem a one-time Manager enrollment grant into a physical-device identity,
 * one Site binding, and the existing device-token compatibility session.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const redeemEnrollmentGrant = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const input = /** @type {Record<string, unknown>} */ (body ?? {});
  const grantId = clean(input.grantId);
  const token = clean(input.token);
  const requestedPhysicalDeviceId = clean(input.physicalDeviceId);
  const label = clean(input.label).slice(0, 100) || "Site Manager device";
  if (!grantId || !token) return jsonResponse(401, INVALID_GRANT);
  if (requestedPhysicalDeviceId && !validDeviceId(requestedPhysicalDeviceId)) {
    return jsonResponse(400, { error: "invalid_physical_device_id" });
  }

  const tableName = getDynamoTableName();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const lookupResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `ENROLLMENT_TOKEN#${tokenHash}`, sk: "#META" },
    }),
  );
  const lookup = lookupResult.Item;
  if (!lookup || lookup.grantId !== grantId) {
    return jsonResponse(401, INVALID_GRANT);
  }
  const grantResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: lookup.grantPk, sk: lookup.grantSk },
    }),
  );
  const grant = grantResult.Item;
  const now = new Date();
  const nowIso = now.toISOString();
  if (
    !grant ||
    grant.status !== "pending" ||
    grant.accessLevel !== "manager" ||
    grant.tokenHash !== tokenHash ||
    grant.expiresAt <= nowIso
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }

  const siteId = String(grant.siteId);
  const membershipId = String(grant.membershipId);
  const physicalDeviceId = requestedPhysicalDeviceId || randomUUID();
  const [siteResult, membershipResult, physicalResult] = await Promise.all([
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
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PHYSICAL_DEVICE#${physicalDeviceId}`, sk: "#META" },
      }),
    ),
  ]);
  const site = siteResult.Item;
  const membership = membershipResult.Item;
  const physical = physicalResult.Item;
  if (
    !site ||
    site.status === "inactive" ||
    !membership ||
    membership.status !== "active" ||
    physical?.status === "revoked"
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }

  const bindingId = randomUUID();
  const generation = 1;
  const [access, refresh] = await Promise.all([
    mintAccessToken(
      {
        siteId,
        deviceId: bindingId,
        tokenGeneration: generation,
        accessLevel: "manager",
      },
      { expiresIn: ACCESS_TTL_SECONDS },
    ),
    mintRefreshToken(
      {
        siteId,
        deviceId: bindingId,
        tokenGeneration: generation,
        accessLevel: "manager",
      },
      { expiresIn: REFRESH_TTL_SECONDS },
    ),
  ]);
  const absoluteExpiresAt = new Date(
    now.getTime() + ABSOLUTE_LIFETIME_MS,
  ).toISOString();
  const siteGeneration = Number(site.siteCredentialGeneration ?? 0);
  const membershipGeneration = Number(membership.generation ?? 1);
  const binding = {
    pk: `SITE#${siteId}`,
    sk: `DEVICE_BINDING#${bindingId}`,
    type: "deviceBinding",
    entityType: "DEVICE_BINDING",
    bindingId,
    physicalDeviceId,
    siteId,
    accessLevel: "manager",
    membershipId,
    membershipGeneration,
    siteCredentialGeneration: siteGeneration,
    label,
    status: "active",
    tokenGeneration: generation,
    refreshJti: refresh.jti,
    enrolledAt: nowIso,
    enrolledByGrantId: grantId,
    lastSeenAt: nowIso,
    absoluteExpiresAt,
    inactivityLimitDays: INACTIVITY_LIMIT_DAYS,
  };
  const legacyDevice = {
    pk: `SITE#${siteId}`,
    sk: `DEVICE#${bindingId}`,
    type: "device",
    deviceId: bindingId,
    bindingId,
    physicalDeviceId,
    siteId,
    siteName: site.name,
    accessLevel: "manager",
    membershipId,
    membershipGeneration,
    siteCredentialGeneration: siteGeneration,
    label,
    status: "active",
    registeredAt: nowIso,
    lastSeenAt: nowIso,
    tokenGeneration: generation,
    refreshJti: refresh.jti,
    absoluteExpiresAt,
    inactivityLimitDays: INACTIVITY_LIMIT_DAYS,
  };
  const physicalWrite = physical
    ? {
        Update: {
          TableName: tableName,
          Key: { pk: physical.pk, sk: physical.sk },
          UpdateExpression:
            "SET lastEnrolledAt = :now, updatedAt = :now, label = :label",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":now": nowIso,
            ":label": label,
            ":revoked": "revoked",
          },
        },
      }
    : put(tableName, {
        pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
        sk: "#META",
        type: "physicalDevice",
        physicalDeviceId,
        label,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
        lastEnrolledAt: nowIso,
      });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: grant.pk, sk: grant.sk },
              UpdateExpression:
                "SET #status = :redeemed, redeemedAt = :now, redeemedBindingId = :bindingId, redeemedPhysicalDeviceId = :physicalDeviceId",
              ConditionExpression:
                "#status = :pending AND expiresAt > :now AND tokenHash = :tokenHash",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":redeemed": "redeemed",
                ":now": nowIso,
                ":tokenHash": tokenHash,
                ":bindingId": bindingId,
                ":physicalDeviceId": physicalDeviceId,
              },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: { pk: lookup.pk, sk: lookup.sk },
              ConditionExpression: "grantId = :grantId",
              ExpressionAttributeValues: { ":grantId": grantId },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: membership.pk, sk: membership.sk },
              ConditionExpression:
                "#status = :active AND generation = :generation",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ":generation": membershipGeneration,
              },
            },
          },
          physicalWrite,
          put(tableName, binding),
          put(tableName, legacyDevice),
          put(tableName, {
            pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
            sk: `BINDING#${bindingId}`,
            type: "physicalDeviceBindingPointer",
            physicalDeviceId,
            bindingId,
            siteId,
            accessLevel: "manager",
            status: "active",
            createdAt: nowIso,
          }),
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${nowIso}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: "manager_grant_redeemed",
            siteId,
            membershipId,
            grantId,
            bindingId,
            physicalDeviceId,
            actor: `physical-device:${physicalDeviceId}`,
            createdAt: nowIso,
          }),
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      return jsonResponse(401, INVALID_GRANT);
    }
    throw error;
  }
  return jsonResponse(201, {
    physicalDeviceId,
    bindingId,
    deviceId: bindingId,
    site: { siteId, name: site.name },
    accessLevel: "manager",
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
    absoluteExpiresAt,
    bindings: [
      {
        bindingId,
        siteId,
        siteName: site.name,
        accessLevel: "manager",
        status: "active",
      },
    ],
  });
};

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
function validDeviceId(value) {
  return /^[A-Za-z0-9_-]{8,100}$/.test(value);
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
