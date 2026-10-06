import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { sendManagerSecurityNotification } from "../integrations/email.js";
import { mintAccessToken, mintRefreshToken } from "../lib/device-token.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const ABSOLUTE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const INACTIVITY_LIMIT_DAYS = 60;
const INVALID_GRANT = { error: "invalid_enrollment_grant" };

/**
 * Redeem a one-time enrollment grant into a physical-device identity,
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
    !["general", "manager"].includes(grant.accessLevel) ||
    grant.tokenHash !== tokenHash ||
    grant.expiresAt <= nowIso
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }

  const siteId = String(grant.siteId);
  const accessLevel = /** @type {"general"|"manager"} */ (grant.accessLevel);
  const membershipId =
    accessLevel === "manager" ? String(grant.membershipId) : "";
  const issuerBindingId =
    accessLevel === "general" ? String(grant.issuedByBindingId) : "";
  const label =
    clean(input.label).slice(0, 100) ||
    clean(grant.label).slice(0, 100) ||
    (accessLevel === "manager" ? "Site Manager device" : "Team device");
  const physicalDeviceId = requestedPhysicalDeviceId || randomUUID();
  const [siteResult, authorityResult, physicalResult] = await Promise.all([
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
          sk:
            accessLevel === "manager"
              ? `MANAGER_MEMBERSHIP#${membershipId}`
              : `DEVICE_BINDING#${issuerBindingId}`,
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
  const authority = authorityResult.Item;
  const physical = physicalResult.Item;
  const issuerMembership =
    accessLevel === "general" && grant.issuerMembershipId
      ? (
          await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                pk: `SITE#${siteId}`,
                sk: `MANAGER_MEMBERSHIP#${grant.issuerMembershipId}`,
              },
            }),
          )
        ).Item
      : undefined;
  if (
    !site ||
    site.status === "inactive" ||
    !authority ||
    authority.status !== "active" ||
    (accessLevel === "general" && authority.accessLevel !== "manager") ||
    (accessLevel === "general" &&
      (!issuerMembership ||
        issuerMembership.status !== "active" ||
        Number(issuerMembership.generation ?? 0) !==
          Number(grant.issuerMembershipGeneration ?? -1))) ||
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
        accessLevel,
      },
      { expiresIn: ACCESS_TTL_SECONDS },
    ),
    mintRefreshToken(
      {
        siteId,
        deviceId: bindingId,
        tokenGeneration: generation,
        accessLevel,
      },
      { expiresIn: REFRESH_TTL_SECONDS },
    ),
  ]);
  const absoluteExpiresAt = new Date(
    now.getTime() + ABSOLUTE_LIFETIME_MS,
  ).toISOString();
  const siteGeneration = Number(site.siteCredentialGeneration ?? 0);
  const membershipGeneration =
    accessLevel === "manager" ? Number(authority.generation ?? 1) : undefined;
  const binding = {
    pk: `SITE#${siteId}`,
    sk: `DEVICE_BINDING#${bindingId}`,
    type: "deviceBinding",
    entityType: "DEVICE_BINDING",
    bindingId,
    physicalDeviceId,
    siteId,
    accessLevel,
    ...(accessLevel === "manager"
      ? { membershipId, membershipGeneration }
      : {}),
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
    accessLevel,
    ...(accessLevel === "manager"
      ? { membershipId, membershipGeneration }
      : {}),
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
          ...(accessLevel === "manager"
            ? [
                {
                  Delete: {
                    TableName: tableName,
                    Key: {
                      pk: `SITE#${siteId}`,
                      sk: `${grant.issuedBy === "manager-email-recovery" ? "MANAGER_RECOVERY_GRANT_CURRENT" : "MANAGER_GRANT_CURRENT"}#${membershipId}`,
                    },
                    ConditionExpression:
                      "attribute_not_exists(pk) OR grantId = :grantId",
                    ExpressionAttributeValues: { ":grantId": grantId },
                  },
                },
              ]
            : []),
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: authority.pk, sk: authority.sk },
              ConditionExpression:
                accessLevel === "manager"
                  ? "#status = :active AND generation = :generation"
                  : "#status = :active AND accessLevel = :manager",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ...(accessLevel === "manager"
                  ? { ":generation": membershipGeneration }
                  : {}),
                ...(accessLevel === "general" ? { ":manager": "manager" } : {}),
              },
            },
          },
          ...(accessLevel === "general"
            ? [
                {
                  ConditionCheck: {
                    TableName: tableName,
                    Key: {
                      pk: `SITE#${siteId}`,
                      sk: `MANAGER_MEMBERSHIP#${grant.issuerMembershipId}`,
                    },
                    ConditionExpression:
                      "#status = :active AND generation = :generation",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":active": "active",
                      ":generation": Number(
                        grant.issuerMembershipGeneration ?? 0,
                      ),
                    },
                  },
                },
              ]
            : []),
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
            accessLevel,
            status: "active",
            createdAt: nowIso,
          }),
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${nowIso}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: `${accessLevel}_grant_redeemed`,
            siteId,
            ...(membershipId ? { membershipId } : {}),
            grantId,
            bindingId,
            physicalDeviceId,
            actor: `physical-device:${physicalDeviceId}`,
            createdAt: nowIso,
          }),
          ...(accessLevel === "general"
            ? [
                {
                  Delete: {
                    TableName: tableName,
                    Key: {
                      pk: `SITE#${siteId}`,
                      sk: `ACTIVE_STAFF_GRANT#${issuerBindingId}`,
                    },
                    ConditionExpression: "grantId = :grantId",
                    ExpressionAttributeValues: { ":grantId": grantId },
                  },
                },
              ]
            : []),
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
  if (accessLevel === "manager") {
    await notifyManagerEnrollment({
      event,
      tableName,
      grant,
      membership: authority,
      site,
      label,
      enrolledAt: nowIso,
    });
  }
  return jsonResponse(201, {
    physicalDeviceId,
    bindingId,
    deviceId: bindingId,
    site: { siteId, name: site.name },
    accessLevel,
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
        accessLevel,
        status: "active",
      },
    ],
  });
};

/**
 * Notification failure must not roll back a successfully redeemed one-time
 * grant. Delivery evidence remains on the redeemed grant and safe logs feed
 * the operational alarm.
 * @param {{event:import("aws-lambda").APIGatewayProxyEventV2, tableName:string, grant:Record<string, any>, membership:Record<string, any>, site:Record<string, any>, label:string, enrolledAt:string}} input
 */
async function notifyManagerEnrollment(input) {
  let status = "accepted";
  let provider = "ses";
  let messageId = "";
  try {
    const delivery = await sendManagerSecurityNotification({
      to: String(input.membership.email),
      managerName: String(input.membership.name || "Site Manager"),
      siteName: String(input.site.name),
      deviceLabel: input.label,
      clientDescription: describeClient(input.event.headers),
      enrolledAt: input.enrolledAt,
      revocationContact:
        process.env.SETUP_CODE_EMAIL_REPLY_TO ||
        process.env.SETUP_CODE_EMAIL_FROM,
    });
    provider = delivery.provider;
    messageId = delivery.messageId;
  } catch {
    status = "failed";
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: input.tableName,
        Key: { pk: input.grant.pk, sk: input.grant.sk },
        UpdateExpression:
          "SET securityNotificationStatus = :status, securityNotificationProvider = :provider, securityNotificationMessageId = :messageId, securityNotificationUpdatedAt = :now",
        ConditionExpression: "#status = :redeemed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":provider": provider,
          ":messageId": messageId,
          ":now": new Date().toISOString(),
          ":redeemed": "redeemed",
        },
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        marker: "ManagerSecurityNotificationEvidenceFailed",
        level: "ERROR",
      }),
    );
  }
  console[status === "failed" ? "error" : "info"](
    JSON.stringify({
      marker: "ManagerSecurityNotification",
      status,
      provider,
      siteId: String(input.site.siteId),
    }),
  );
}

/** @param {Record<string, string | undefined> | undefined} headers */
function describeClient(headers = {}) {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "user-agent",
  );
  const userAgent = entry?.[1] ?? "";
  const platform = /android/i.test(userAgent)
    ? "Android"
    : /iphone|ipad|ipod/i.test(userAgent)
      ? "iOS/iPadOS"
      : /windows/i.test(userAgent)
        ? "Windows"
        : /cros/i.test(userAgent)
          ? "ChromeOS"
          : /macintosh|mac os/i.test(userAgent)
            ? "macOS"
            : /linux/i.test(userAgent)
              ? "Linux"
              : "unknown device";
  const browser = /edg\//i.test(userAgent)
    ? "Edge"
    : /firefox\//i.test(userAgent)
      ? "Firefox"
      : /chrome\//i.test(userAgent) || /crios\//i.test(userAgent)
        ? "Chrome"
        : /safari\//i.test(userAgent)
          ? "Safari"
          : "unknown browser";
  return `${browser} on ${platform}`;
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
