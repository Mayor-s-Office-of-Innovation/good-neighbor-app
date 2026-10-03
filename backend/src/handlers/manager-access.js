import { createHash, randomBytes, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import {
  deriveAccessLevel,
  deriveActorId,
  deriveSiteId,
} from "../lib/principal.js";

const GRANT_TTL_MS = 10 * 60 * 1000;
const MANAGER_HOURLY_LIMIT = 25;
const SITE_HOURLY_LIMIT = 40;

/** Create one short-lived general-access enrollment grant. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const createStaffGrant = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "manager_access_required" });
  }
  let body;
  try {
    body = /** @type {Record<string, unknown>} */ (readJsonBody(event) ?? {});
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const label = String(body.label ?? "")
    .trim()
    .slice(0, 100);
  if (!label) return jsonResponse(400, { error: "device_label_required" });

  const siteId = deriveSiteId(event);
  const issuerBindingId = deriveActorId(event);
  const tableName = getDynamoTableName();
  const now = new Date();
  const nowIso = now.toISOString();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const [siteResult, issuerResult, grantsResult] = await Promise.all([
    get(tableName, `SITE#${siteId}`, "#META"),
    get(tableName, `SITE#${siteId}`, `DEVICE_BINDING#${issuerBindingId}`),
    ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :start AND :end",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":start": `STAFF_GRANT#${hourAgo}`,
          ":end": "STAFF_GRANT#~",
        },
        ScanIndexForward: false,
      }),
    ),
  ]);
  const site = siteResult.Item;
  const issuer = issuerResult.Item;
  if (!site || site.status === "inactive") {
    return jsonResponse(404, { error: "site_not_found" });
  }
  if (
    !issuer ||
    issuer.status !== "active" ||
    issuer.accessLevel !== "manager"
  ) {
    return jsonResponse(403, { error: "manager_access_required" });
  }

  const recent = grantsResult.Items ?? [];
  if (recent.length >= SITE_HOURLY_LIMIT) {
    return jsonResponse(429, { error: "site_grant_rate_limited" });
  }
  if (
    recent.filter((item) => item.issuedByBindingId === issuerBindingId)
      .length >= MANAGER_HOURLY_LIMIT
  ) {
    return jsonResponse(429, { error: "manager_grant_rate_limited" });
  }

  const grantId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();
  const grant = {
    pk: `SITE#${siteId}`,
    sk: `STAFF_GRANT#${nowIso}#${grantId}`,
    type: "enrollmentGrant",
    entityType: "ENROLLMENT_GRANT",
    grantId,
    siteId,
    accessLevel: "general",
    label,
    tokenHash,
    status: "pending",
    issuedBy: `binding:${issuerBindingId}`,
    issuedByBindingId: issuerBindingId,
    issuerMembershipId: issuer.membershipId,
    issuerMembershipGeneration: Number(issuer.membershipGeneration ?? 0),
    createdAt: nowIso,
    expiresAt,
  };
  const activeKey = {
    pk: `SITE#${siteId}`,
    sk: `ACTIVE_STAFF_GRANT#${issuerBindingId}`,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
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
          {
            Put: {
              TableName: tableName,
              Item: {
                ...activeKey,
                type: "activeStaffGrant",
                grantId,
                grantPk: grant.pk,
                grantSk: grant.sk,
                tokenHash,
                expiresAt,
              },
              ConditionExpression:
                "attribute_not_exists(pk) OR expiresAt <= :now",
              ExpressionAttributeValues: { ":now": nowIso },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: issuer.pk, sk: issuer.sk },
              ConditionExpression:
                "#status = :active AND accessLevel = :manager",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ":manager": "manager",
              },
            },
          },
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${nowIso}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: "staff_grant_issued",
            siteId,
            grantId,
            targetLabel: label,
            actor: `binding:${issuerBindingId}`,
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
      return jsonResponse(409, { error: "active_staff_grant_exists" });
    }
    throw error;
  }

  const enrollmentUrl = new URL(
    process.env.PROVIDER_APP_URL ?? "http://localhost:5173/",
  );
  enrollmentUrl.hash = new URLSearchParams({
    enrollment_grant: grantId,
    enrollment_token: token,
  }).toString();
  return jsonResponse(201, {
    grant: publicGrant(grant, nowIso),
    enrollmentUrl: enrollmentUrl.toString(),
  });
};

/** Return the current Manager binding's unfinished staff grant, if any. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const getCurrentStaffGrant = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "manager_access_required" });
  }
  const siteId = deriveSiteId(event);
  const issuerBindingId = deriveActorId(event);
  const tableName = getDynamoTableName();
  const markerResult = await get(
    tableName,
    `SITE#${siteId}`,
    `ACTIVE_STAFF_GRANT#${issuerBindingId}`,
  );
  const marker = markerResult.Item;
  if (!marker) return jsonResponse(200, { grant: null });
  const grantResult = await get(tableName, marker.grantPk, marker.grantSk);
  const grant = grantResult.Item;
  if (!grant || grant.issuedByBindingId !== issuerBindingId) {
    return jsonResponse(200, { grant: null });
  }
  return jsonResponse(200, { grant: publicGrant(grant) });
};

/** Cancel this Manager binding's current staff grant. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const cancelStaffGrant = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "manager_access_required" });
  }
  const siteId = deriveSiteId(event);
  const issuerBindingId = deriveActorId(event);
  const grantId = String(event.pathParameters?.grantId ?? "");
  const tableName = getDynamoTableName();
  const markerKey = {
    pk: `SITE#${siteId}`,
    sk: `ACTIVE_STAFF_GRANT#${issuerBindingId}`,
  };
  const markerResult = await get(tableName, markerKey.pk, markerKey.sk);
  const marker = markerResult.Item;
  if (!marker || marker.grantId !== grantId) {
    return jsonResponse(404, { error: "staff_grant_not_found" });
  }
  const grantResult = await get(tableName, marker.grantPk, marker.grantSk);
  const grant = grantResult.Item;
  if (
    !grant ||
    grant.status !== "pending" ||
    grant.issuedByBindingId !== issuerBindingId
  ) {
    return jsonResponse(404, { error: "staff_grant_not_found" });
  }
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: grant.pk, sk: grant.sk },
              UpdateExpression: "SET #status = :cancelled, cancelledAt = :now",
              ConditionExpression:
                "#status = :pending AND issuedByBindingId = :issuer",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":cancelled": "cancelled",
                ":now": now,
                ":issuer": issuerBindingId,
              },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: { pk: `ENROLLMENT_TOKEN#${grant.tokenHash}`, sk: "#META" },
              ConditionExpression: "grantId = :grantId",
              ExpressionAttributeValues: { ":grantId": grantId },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: markerKey,
              ConditionExpression: "grantId = :grantId",
              ExpressionAttributeValues: { ":grantId": grantId },
            },
          },
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${now}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: "staff_grant_cancelled",
            siteId,
            grantId,
            actor: `binding:${issuerBindingId}`,
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
      return jsonResponse(409, { error: "staff_grant_cancel_conflict" });
    }
    throw error;
  }
  return jsonResponse(200, {
    grant: { ...publicGrant(grant, now), status: "cancelled" },
  });
};

/** List general-access bindings at the Manager's current Site. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const listGeneralBindings = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "manager_access_required" });
  }
  const siteId = deriveSiteId(event);
  const result = await ddb.send(
    new QueryCommand({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": "DEVICE_BINDING#",
      },
    }),
  );
  return jsonResponse(200, {
    bindings: (result.Items ?? [])
      .filter((item) => item.accessLevel === "general")
      .map(publicBinding),
  });
};

/** Revoke one general-access binding at the Manager's current Site. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const revokeGeneralBinding = async (event) => {
  if (deriveAccessLevel(event) !== "manager") {
    return jsonResponse(403, { error: "manager_access_required" });
  }
  const siteId = deriveSiteId(event);
  const bindingId = String(event.pathParameters?.bindingId ?? "");
  const tableName = getDynamoTableName();
  const [result, deviceResult] = await Promise.all([
    get(tableName, `SITE#${siteId}`, `DEVICE_BINDING#${bindingId}`),
    get(tableName, `SITE#${siteId}`, `DEVICE#${bindingId}`),
  ]);
  const binding = result.Item;
  const device = deviceResult.Item;
  if (!binding || binding.accessLevel !== "general") {
    return jsonResponse(404, { error: "general_binding_not_found" });
  }
  if (binding.status === "revoked") {
    return jsonResponse(200, { binding: publicBinding(binding) });
  }
  const now = new Date().toISOString();
  if (!device)
    return jsonResponse(409, { error: "binding_projection_missing" });
  const nextGeneration = Number(device.tokenGeneration ?? 0) + 1;
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          revokeUpdate(tableName, binding.pk, binding.sk, binding, now),
          revokeUpdate(
            tableName,
            `SITE#${siteId}`,
            `DEVICE#${bindingId}`,
            device,
            now,
          ),
          {
            Update: {
              TableName: tableName,
              Key: {
                pk: `PHYSICAL_DEVICE#${binding.physicalDeviceId}`,
                sk: `BINDING#${bindingId}`,
              },
              UpdateExpression: "SET #status = :revoked, updatedAt = :now",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":revoked": "revoked", ":now": now },
            },
          },
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${now}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: "general_binding_revoked",
            siteId,
            bindingId,
            physicalDeviceId: binding.physicalDeviceId,
            actor: `binding:${deriveActorId(event)}`,
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
      return jsonResponse(409, { error: "binding_revocation_conflict" });
    }
    throw error;
  }
  return jsonResponse(200, {
    binding: {
      ...publicBinding(binding),
      status: "revoked",
      tokenGeneration: nextGeneration,
    },
  });
};

/** @param {string} tableName @param {string} pk @param {string} sk */
function get(tableName, pk, sk) {
  return ddb.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
}

/** @param {string} tableName @param {Record<string, unknown>} Item */
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

/** @param {Record<string, any>} item @param {string} [now] */
function publicGrant(item, now = new Date().toISOString()) {
  return {
    grantId: item.grantId,
    label: item.label,
    accessLevel: "general",
    status:
      item.status === "pending" && item.expiresAt <= now
        ? "expired"
        : item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

/** @param {Record<string, any>} item */
function publicBinding(item) {
  return {
    bindingId: item.bindingId,
    physicalDeviceId: item.physicalDeviceId,
    label: item.label,
    accessLevel: "general",
    status: item.status,
    enrolledAt: item.enrolledAt,
    lastSeenAt: item.lastSeenAt,
    absoluteExpiresAt: item.absoluteExpiresAt,
  };
}

/** @param {string} tableName @param {string} pk @param {string} sk @param {Record<string, any>} item @param {string} now */
function revokeUpdate(tableName, pk, sk, item, now) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk, sk },
      UpdateExpression:
        "SET #status = :revoked, revokedAt = :now, updatedAt = :now, tokenGeneration = :next",
      ConditionExpression: "#status = :active AND tokenGeneration = :current",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "active",
        ":revoked": "revoked",
        ":now": now,
        ":current": Number(item.tokenGeneration ?? 0),
        ":next": Number(item.tokenGeneration ?? 0) + 1,
      },
    },
  };
}
