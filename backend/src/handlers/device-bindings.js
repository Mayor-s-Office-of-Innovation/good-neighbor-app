import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { mintAccessToken, mintRefreshToken } from "../lib/device-token.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listDeviceBindings = async (event) => {
  const current = await currentDevice(event);
  if (!current) return jsonResponse(401, { error: "invalid_device_binding" });
  const result = await ddb.send(
    new QueryCommand({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `PHYSICAL_DEVICE#${current.physicalDeviceId}`,
        ":prefix": "BINDING#",
      },
    }),
  );
  const bindings = [];
  for (const pointer of result.Items ?? []) {
    const resolved = await resolveBinding(pointer, current.physicalDeviceId);
    if (resolved) bindings.push(resolved.publicBinding);
  }
  return jsonResponse(200, {
    physicalDeviceId: current.physicalDeviceId,
    currentBindingId: current.deviceId,
    bindings,
  });
};

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const selectDeviceBinding = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const bindingId = String(
    /** @type {Record<string, unknown>} */ (body ?? {}).bindingId ?? "",
  ).trim();
  if (!bindingId) return jsonResponse(400, { error: "binding_required" });
  const current = await currentDevice(event);
  if (!current) return jsonResponse(401, { error: "invalid_device_binding" });
  const tableName = getDynamoTableName();
  const pointerResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: `PHYSICAL_DEVICE#${current.physicalDeviceId}`,
        sk: `BINDING#${bindingId}`,
      },
    }),
  );
  const resolved = await resolveBinding(
    pointerResult.Item,
    current.physicalDeviceId,
  );
  if (!resolved) return jsonResponse(404, { error: "binding_not_found" });
  const { device, binding, site } = resolved;
  const generation = Number(device.tokenGeneration ?? 0) + 1;
  const [access, refresh] = await Promise.all([
    mintAccessToken(
      {
        siteId: binding.siteId,
        deviceId: binding.bindingId,
        tokenGeneration: generation,
        accessLevel: binding.accessLevel,
      },
      { expiresIn: ACCESS_TTL_SECONDS },
    ),
    mintRefreshToken(
      {
        siteId: binding.siteId,
        deviceId: binding.bindingId,
        tokenGeneration: generation,
        accessLevel: binding.accessLevel,
      },
      { expiresIn: REFRESH_TTL_SECONDS },
    ),
  ]);
  const now = new Date().toISOString();
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          sessionUpdate(tableName, device, generation, refresh.jti, now),
          sessionUpdate(tableName, binding, generation, refresh.jti, now),
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: `SITE#${binding.siteId}`,
                sk: `AUDIT#${now}#${randomUUID()}`,
                type: "siteAuditEvent",
                eventType: "device_binding_selected",
                siteId: binding.siteId,
                bindingId: binding.bindingId,
                previousBindingId: current.deviceId,
                physicalDeviceId: current.physicalDeviceId,
                actor: `physical-device:${current.physicalDeviceId}`,
                createdAt: now,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      return jsonResponse(409, { error: "binding_selection_conflict" });
    }
    throw error;
  }
  return jsonResponse(200, {
    physicalDeviceId: current.physicalDeviceId,
    bindingId: binding.bindingId,
    deviceId: binding.bindingId,
    site: { siteId: binding.siteId, name: site.name },
    accessLevel: binding.accessLevel,
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
    absoluteExpiresAt: binding.absoluteExpiresAt,
  });
};

/**
 * Load the authenticated binding's compatibility record.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {Promise<Record<string, any> | null>}
 */
async function currentDevice(event) {
  const authorizedEvent =
    /** @type {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} */ (
      /** @type {unknown} */ (event)
    );
  const siteId = deriveSiteId(authorizedEvent);
  const deviceId = deriveActorId(authorizedEvent);
  const result = await ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${deviceId}` },
    }),
  );
  const device = result.Item;
  return device?.physicalDeviceId &&
    (!device.status || device.status === "active")
    ? device
    : null;
}

/**
 * Resolve an ownership pointer into a currently usable Site binding.
 * @param {Record<string, any> | undefined} pointer
 * @param {string} physicalDeviceId
 * @returns {Promise<null | {binding: Record<string, any>, device: Record<string, any>, site: Record<string, any>, publicBinding: Record<string, any>} >}
 */
async function resolveBinding(pointer, physicalDeviceId) {
  if (
    !pointer ||
    pointer.physicalDeviceId !== physicalDeviceId ||
    pointer.status !== "active"
  ) {
    return null;
  }
  const tableName = getDynamoTableName();
  const [bindingResult, deviceResult, siteResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${pointer.siteId}`,
          sk: `DEVICE_BINDING#${pointer.bindingId}`,
        },
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${pointer.siteId}`,
          sk: `DEVICE#${pointer.bindingId}`,
        },
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
  const device = deviceResult.Item;
  const site = siteResult.Item;
  const now = new Date().toISOString();
  const inactivityLimitMs =
    Number(binding?.inactivityLimitDays ?? 60) * 24 * 60 * 60 * 1000;
  const lastSeenAt = Date.parse(String(device?.lastSeenAt ?? ""));
  if (
    !binding ||
    binding.physicalDeviceId !== physicalDeviceId ||
    binding.status !== "active" ||
    !["general", "manager"].includes(binding.accessLevel) ||
    binding.absoluteExpiresAt <= now ||
    !device ||
    device.status !== "active" ||
    !Number.isFinite(lastSeenAt) ||
    Date.now() - lastSeenAt > inactivityLimitMs ||
    !site ||
    site.status === "inactive" ||
    Number(binding.siteCredentialGeneration ?? 0) !==
      Number(site.siteCredentialGeneration ?? 0)
  ) {
    return null;
  }
  if (binding.accessLevel === "manager") {
    const membershipResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${binding.siteId}`,
          sk: `MANAGER_MEMBERSHIP#${binding.membershipId}`,
        },
      }),
    );
    if (
      membershipResult.Item?.status !== "active" ||
      Number(membershipResult.Item?.generation ?? 0) !==
        Number(binding.membershipGeneration ?? -1)
    ) {
      return null;
    }
  }
  return {
    binding,
    device,
    site,
    publicBinding: {
      bindingId: binding.bindingId,
      siteId: binding.siteId,
      siteName: site.name,
      accessLevel: binding.accessLevel,
      label: binding.label,
      status: binding.status,
      enrolledAt: binding.enrolledAt,
      lastSeenAt: device.lastSeenAt,
      absoluteExpiresAt: binding.absoluteExpiresAt,
    },
  };
}

/**
 * Build one conditional rotating-session update.
 * @param {string} tableName
 * @param {Record<string, any>} item
 * @param {number} generation
 * @param {string} refreshJti
 * @param {string} now
 * @returns {Record<string, any>}
 */
function sessionUpdate(tableName, item, generation, refreshJti, now) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression:
        "SET tokenGeneration = :next, refreshJti = :jti, lastSeenAt = :now",
      ConditionExpression: "#status = :active AND tokenGeneration = :current",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "active",
        ":current": Number(item.tokenGeneration ?? 0),
        ":next": generation,
        ":jti": refreshJti,
        ":now": now,
      },
    },
  };
}
