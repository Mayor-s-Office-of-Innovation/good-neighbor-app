// Device registration + token refresh (Option 4 device auth — see
// docs/adr/0010-device-token-auth.md). The device is the shared front-desk
// tablet; it registers ONCE against the site code and must never need the code
// again — the code-holder (a manager) may be unavailable while workers use the
// device daily. So registration mints a long-lived session (30-day access +
// 180-day rotating refresh), and the client refreshes silently thereafter.
//
// Tenant invariant: both routes resolve siteId server-side from the
// `SITE_CODE#<code>` item or the verified refresh token — the body never
// asserts a site. Revocation = `tokenGeneration` bump (or device delete) on the
// DEVICE# item; the authorizer compares a token's `ver` claim to it, and the
// refresh path additionally pins rotation to the item's current `refreshJti`.

import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { normalizeSiteCode } from "./site-code.js";
import { deviceKey } from "./keys.js";
import {
  DeviceTokenError,
  mintAccessToken,
  mintRefreshToken,
  verifyDeviceToken,
} from "../lib/device-token.js";

/**
 * One device identity + its current session state. `tokenGeneration` is the
 * revocation counter: bumping it invalidates every outstanding token (ver
 * mismatch). `refreshJti` holds the CURRENT single-use refresh token's id —
 * rotation on use; an old refresh token's jti no longer matches.
 * @typedef {object} DeviceItem
 * @property {string} pk
 * @property {string} sk
 * @property {"device"} type
 * @property {string} deviceId
 * @property {string} siteId
 * @property {string} siteName
 * @property {string} label
 * @property {string} registeredAt
 * @property {string} lastSeenAt
 * @property {number} tokenGeneration
 * @property {string} refreshJti
 */

/**
 * POST /v1/devices — register a device against a site code. Idempotent per
 * deviceId: a known device re-presenting a valid code (e.g. re-setup after a
 * wipe) gets a fresh session and its tokenGeneration advances, which
 * invalidates any tokens minted before the re-registration.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const registerDevice = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const raw =
    /** @type {{ code?: unknown, deviceId?: unknown, label?: unknown }} */ (
      body ?? {}
    );
  const code = normalizeSiteCode(typeof raw.code === "string" ? raw.code : "");
  if (!code) {
    return jsonResponse(400, { error: "missing_site_code" });
  }

  const dynamoTable = getDynamoTableName();
  const now = new Date().toISOString();

  // Same lookup + shape as the /site-code handler — the code is the
  // registration credential this phase (docs/adr/0010).
  const siteRes = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: { pk: `SITE_CODE#${code}`, sk: "#META" },
    }),
  );
  const site =
    /** @type {{ siteId?: string, siteName?: string, active?: boolean } | undefined} */ (
      siteRes.Item
    );
  if (!site?.active || !site.siteId || !site.siteName) {
    return jsonResponse(401, { error: "invalid_site_code" });
  }

  // Known device re-registering (idempotent path) — else a fresh opaque id.
  // The item is keyed DEVICE#<providedId>, so item.deviceId === providedId by
  // construction; getDevice only confirms an existing row for that exact key.
  const existing = await getDevice(site.siteId, raw.deviceId);
  const deviceId = existing ? existing.deviceId : newDeviceId(raw.deviceId);
  const generation = (existing?.tokenGeneration ?? 0) + 1;

  const Item = /** @type {DeviceItem} */ ({
    ...deviceKey(site.siteId, deviceId),
    type: "device",
    deviceId,
    siteId: site.siteId,
    siteName: site.siteName,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim().slice(0, 100)
        : (existing?.label ?? "Front desk"),
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: now,
    tokenGeneration: generation,
    // refreshJti is stamped by mintSession below; PutItem first so a fresh
    // device row exists even if the client dies before receiving its tokens.
    refreshJti: "",
  });

  await ddb.send(new PutCommand({ TableName: dynamoTable, Item }));

  const session = await mintSession({
    siteId: site.siteId,
    deviceId,
    generation,
    dynamoTable,
    now,
  });

  return jsonResponse(201, {
    deviceId,
    site: { siteId: site.siteId, name: site.siteName },
    ...session,
  });
};

/**
 * POST /v1/devices/token:refresh — rotate the session. The refresh token is
 * single-use: it must match the DEVICE# item's current `refreshJti`, and each
 * successful refresh bumps `tokenGeneration` (invalidating the previous access
 * token immediately) and stores the new jti. A replayed refresh token fails the
 * jti comparison; a revoked device fails the generation comparison.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const refreshDeviceToken = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const { refreshToken } = /** @type {{ refreshToken?: unknown }} */ (
    body ?? {}
  );
  if (typeof refreshToken !== "string" || !refreshToken) {
    return jsonResponse(400, { error: "missing_refresh_token" });
  }

  let claims;
  try {
    claims = await verifyDeviceToken(refreshToken);
  } catch (err) {
    return jsonResponse(401, {
      error: "invalid_refresh_token",
      reason: err instanceof DeviceTokenError ? err.code : "unknown",
    });
  }
  if (claims.typ !== "refresh") {
    return jsonResponse(401, {
      error: "invalid_refresh_token",
      reason: "not_a_refresh_token",
    });
  }

  const dynamoTable = getDynamoTableName();
  const siteId = claims.siteId;
  const deviceId = claims.sub;

  const res = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: { ...deviceKey(siteId, deviceId) },
    }),
  );
  const device = /** @type {DeviceItem | undefined} */ (res.Item);
  if (
    !device ||
    device.tokenGeneration !== claims.ver || // revoked (generation bumped)
    !claims.jti ||
    device.refreshJti !== claims.jti // already used / superseded
  ) {
    return jsonResponse(401, {
      error: "invalid_refresh_token",
      reason: "revoked_or_replayed",
    });
  }

  const now = new Date().toISOString();
  const session = await mintSession({
    siteId,
    deviceId,
    generation: device.tokenGeneration + 1,
    dynamoTable,
    now,
  });

  return jsonResponse(200, {
    deviceId,
    site: { siteId, name: device.siteName },
    ...session,
  });
};

/**
 * Mint the access + refresh pair and persist the new session state (generation
 * + refresh jti + lastSeenAt) onto the DEVICE# item. Shared by register +
 * refresh; the caller has already validated identity and chosen the generation.
 * @param {{ siteId: string, deviceId: string, generation: number, dynamoTable: string, now: string }} s
 * @returns {Promise<{ token: string, refreshToken: string, expiresIn: number, refreshExpiresIn: number, tokenGeneration: number }>}
 */
async function mintSession({ siteId, deviceId, generation, dynamoTable, now }) {
  const [access, refresh] = await Promise.all([
    mintAccessToken({ siteId, deviceId, tokenGeneration: generation }),
    mintRefreshToken({ siteId, deviceId, tokenGeneration: generation }),
  ]);

  await ddb.send(
    new UpdateCommand({
      TableName: dynamoTable,
      Key: { ...deviceKey(siteId, deviceId) },
      UpdateExpression:
        "SET tokenGeneration = :g, refreshJti = :jti, lastSeenAt = :seen",
      ExpressionAttributeValues: {
        ":g": generation,
        ":jti": refresh.jti,
        ":seen": now,
      },
    }),
  );

  return {
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
  };
}

/**
 * Fetch a device item when the caller says which device it is
 * (re-registration after a wipe). undefined when absent/mismatched.
 * @param {string} siteId
 * @param {unknown} deviceId
 * @returns {Promise<DeviceItem | undefined>}
 */
async function getDevice(siteId, deviceId) {
  if (typeof deviceId !== "string" || !deviceId) return undefined;
  const res = await ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key: { ...deviceKey(siteId, deviceId) },
    }),
  );
  const item = /** @type {DeviceItem | undefined} */ (res.Item);
  return item?.deviceId === deviceId ? item : undefined;
}

/**
 * Accept a caller-supplied id (re-registration) or mint a fresh opaque id.
 * @param {unknown} provided
 * @returns {string}
 */
function newDeviceId(provided) {
  return typeof provided === "string" && provided ? provided : randomUUID();
}
