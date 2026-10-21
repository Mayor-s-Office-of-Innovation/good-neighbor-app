// Session handoff for Home Screen installs (notes/pwa-session-handoff-plan.md).
//
// An iOS Home Screen web app runs in its own storage container, so the device
// session a person established in Safari is absent on the first standalone
// launch and they were asked for the setup code again. The fix: while a bound
// device runs in Safari it mints a short-lived, single-use handoff grant for
// its OWN binding (issue, authorized) and puts it in the manifest's start_url
// fragment; the installed app finds it on first launch, with no session in
// IndexedDB, and redeems it (redeem, open route) for a fresh token pair on the
// SAME device record. The generation bump kills the Safari copy's tokens —
// the same rotation /device-bindings/select performs.
//
// The grant carries no authority of its own: no access level, no site name.
// The session is minted from the device record as it stands at redeem time,
// through the same liveness checks the authorizer and refresh apply, so a
// suspension, site credential rotation, or membership removal between issue
// and redeem is honored. Only the token's sha256 is stored (constant-time
// compare on redeem); the token itself travels in a URL fragment and a JSON
// body only, never a query string, header, or log line. Keep it that way: do
// not log the parsed body on any path.
//
// `expiresAt` is stored as EPOCH SECONDS so the table's TTL (attribute
// `expiresAt`, numeric only) reclaims grants; enrollment grants store ISO
// strings there and are never auto-deleted. Don't copy that.

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { URLSearchParams } from "node:url";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deviceLivenessProblem } from "../lib/device-liveness.js";
import {
  canonicalAccessLevel,
  mintAccessToken,
  mintRefreshToken,
} from "../lib/device-token.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import { bindingLifecycleValid } from "./devices.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Pending-grant lifetime. A knob, not a principle (plan § Backend). */
export const HANDOFF_TTL_SECONDS = 7 * 24 * 60 * 60;
export const HANDOFF_GRANT_PARAM = "handoff_grant";
export const HANDOFF_TOKEN_PARAM = "handoff_token";

const INVALID_GRANT = { error: "invalid_handoff_grant" };
const INVALID_DEVICE = { error: "invalid_device_binding" };

/** @param {string} grantId */
const grantKey = (grantId) => ({
  pk: `SESSION_HANDOFF#${grantId}`,
  sk: "#META",
});

/**
 * Build the start URL the installed app launches at. One place for the
 * parameter names: the client parses what this emits.
 * @param {string} grantId
 * @param {string} token
 * @returns {string}
 */
export function handoffStartUrl(grantId, token) {
  const params = new URLSearchParams();
  params.set(HANDOFF_GRANT_PARAM, grantId);
  params.set(HANDOFF_TOKEN_PARAM, token);
  return `/#${params.toString()}`;
}

/**
 * POST /app/v1/session-handoff — mint a handoff grant for the calling device.
 * Authorized: site and device come from the verified claims, never the body.
 * One pending grant per device: the previous one is superseded.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const issueSessionHandoff = async (event) => {
  const authorizedEvent =
    /** @type {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} */ (
      /** @type {unknown} */ (event)
    );
  const siteId = deriveSiteId(authorizedEvent);
  const deviceId = deriveActorId(authorizedEvent);
  const tableName = getDynamoTableName();
  const now = new Date();
  const nowIso = now.toISOString();

  const deviceResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${deviceId}` },
    }),
  );
  const device = deviceResult.Item;
  if (!device || deviceLivenessProblem(device, now)) {
    return jsonResponse(401, INVALID_DEVICE);
  }

  const grantId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = Math.floor(now.getTime() / 1000) + HANDOFF_TTL_SECONDS;

  // Supersede the previous pending grant, best-effort: it may already be
  // redeemed, superseded, or reclaimed by TTL, and none of those should stop
  // a new one from being issued.
  if (typeof device.handoffGrantId === "string" && device.handoffGrantId) {
    await supersedeGrant(tableName, device.handoffGrantId, nowIso);
  }

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                ...grantKey(grantId),
                type: "sessionHandoffGrant",
                grantId,
                siteId,
                deviceId,
                ...(device.bindingId ? { bindingId: device.bindingId } : {}),
                tokenHash,
                status: "pending",
                issuedAt: nowIso,
                issuedTokenGeneration: Number(device.tokenGeneration ?? 0),
                expiresAt,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk: device.pk, sk: device.sk },
              UpdateExpression: "SET handoffGrantId = :grantId",
              // Legacy setup-code devices carry no `status`.
              ConditionExpression:
                "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status = :active)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":grantId": grantId,
                ":active": "active",
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: `SITE#${siteId}`,
                sk: `AUDIT#${nowIso}#${randomUUID()}`,
                type: "siteAuditEvent",
                eventType: "session_handoff_issued",
                siteId,
                deviceId,
                ...(device.bindingId ? { bindingId: device.bindingId } : {}),
                grantId,
                actor: `device:${deviceId}`,
                createdAt: nowIso,
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
      return jsonResponse(401, INVALID_DEVICE);
    }
    throw error;
  }

  return jsonResponse(200, {
    grantId,
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    startUrl: handoffStartUrl(grantId, token),
  });
};

/**
 * POST /app/v1/session-handoff/redeem — exchange a pending grant for a fresh
 * session on the device it was issued for. Open route: every failure is the
 * same 401 so the response never distinguishes unknown, expired, replayed, and
 * revoked.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const redeemSessionHandoff = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const input = /** @type {Record<string, unknown>} */ (body ?? {});
  const grantId = clean(input.grantId);
  const token = clean(input.token);
  if (!grantId || !token) return jsonResponse(401, INVALID_GRANT);

  const tableName = getDynamoTableName();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const grantResult = await ddb.send(
    new GetCommand({ TableName: tableName, Key: grantKey(grantId) }),
  );
  const grant = grantResult.Item;
  if (
    !grant ||
    grant.status !== "pending" ||
    Number(grant.expiresAt ?? 0) <= nowSeconds ||
    !hashMatches(String(grant.tokenHash ?? ""), token)
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }

  const siteId = String(grant.siteId);
  const deviceId = String(grant.deviceId);
  const bindingId = typeof grant.bindingId === "string" ? grant.bindingId : "";
  const [deviceResult, bindingResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${deviceId}` },
      }),
    ),
    bindingId
      ? ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: `SITE#${siteId}`, sk: `DEVICE_BINDING#${bindingId}` },
          }),
        )
      : Promise.resolve({ Item: undefined }),
  ]);
  const device = deviceResult.Item;
  const binding = bindingResult.Item;
  if (
    !device ||
    deviceLivenessProblem(device, now) ||
    (bindingId && (!binding || deviceLivenessProblem(binding, now)))
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }
  const accessLevel = canonicalAccessLevel(device.accessLevel);
  if (
    !(await bindingLifecycleValid(
      /** @type {import("./devices.js").DeviceItem & Record<string, any>} */ (
        device
      ),
      accessLevel,
    ))
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }

  const generation = Number(device.tokenGeneration ?? 0) + 1;
  const subject = {
    siteId,
    deviceId,
    tokenGeneration: generation,
    accessLevel,
  };
  const [access, refresh] = await Promise.all([
    mintAccessToken(subject, { expiresIn: ACCESS_TTL_SECONDS }),
    mintRefreshToken(subject, { expiresIn: REFRESH_TTL_SECONDS }),
  ]);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          rotateSession(tableName, device, generation, refresh.jti, nowIso),
          ...(binding
            ? [
                rotateSession(
                  tableName,
                  binding,
                  generation,
                  refresh.jti,
                  nowIso,
                ),
              ]
            : []),
          {
            Update: {
              TableName: tableName,
              Key: grantKey(grantId),
              UpdateExpression:
                "SET #status = :redeemed, redeemedAt = :now, redeemedTokenGeneration = :generation",
              ConditionExpression:
                "#status = :pending AND expiresAt > :nowSeconds",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":redeemed": "redeemed",
                ":now": nowIso,
                ":nowSeconds": nowSeconds,
                ":generation": generation,
              },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: `SITE#${siteId}`,
                sk: `AUDIT#${nowIso}#${randomUUID()}`,
                type: "siteAuditEvent",
                eventType: "session_handed_off",
                siteId,
                deviceId,
                ...(bindingId ? { bindingId } : {}),
                grantId,
                previousTokenGeneration: Number(device.tokenGeneration ?? 0),
                tokenGeneration: generation,
                actor: `device:${deviceId}`,
                createdAt: nowIso,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    // Replay race, a rotation that moved the generation first, or a device
    // revoked between the read and the write: fail closed, same 401.
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      return jsonResponse(401, INVALID_GRANT);
    }
    throw error;
  }

  return jsonResponse(200, {
    deviceId,
    ...(bindingId ? { bindingId } : {}),
    ...(device.physicalDeviceId
      ? { physicalDeviceId: device.physicalDeviceId }
      : {}),
    site: { siteId, name: String(device.siteName ?? "") },
    accessLevel,
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
    ...(device.absoluteExpiresAt
      ? { absoluteExpiresAt: device.absoluteExpiresAt }
      : {}),
  });
};

/**
 * The session rotation on a DEVICE# or DEVICE_BINDING# item, conditioned on
 * the generation observed in the read so a concurrent refresh or redeem
 * cannot both win. Unlike device-bindings.js's `sessionUpdate`, a missing
 * `status` is accepted: legacy setup-code devices never had one.
 * @param {string} tableName
 * @param {Record<string, any>} item
 * @param {number} generation
 * @param {string} refreshJti
 * @param {string} now
 */
function rotateSession(tableName, item, generation, refreshJti, now) {
  return {
    Update: {
      TableName: tableName,
      Key: { pk: item.pk, sk: item.sk },
      UpdateExpression:
        "SET tokenGeneration = :next, refreshJti = :jti, lastSeenAt = :now REMOVE handoffGrantId",
      ConditionExpression:
        "(attribute_not_exists(#status) OR #status = :active) AND tokenGeneration = :current",
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

/**
 * Mark an earlier pending grant superseded. Conditional on it still being
 * pending; any other state (or a TTL-reclaimed item) is left alone.
 * @param {string} tableName
 * @param {string} grantId
 * @param {string} nowIso
 */
async function supersedeGrant(tableName, grantId, nowIso) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: grantKey(grantId),
        UpdateExpression: "SET #status = :superseded, supersededAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":superseded": "superseded",
          ":pending": "pending",
          ":now": nowIso,
        },
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return;
    }
    throw error;
  }
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Constant-time comparison of the stored hash against the presented token.
 * @param {string} storedHash
 * @param {string} token
 */
function hashMatches(storedHash, token) {
  const presented = Buffer.from(sha256(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return (
    stored.length === presented.length && timingSafeEqual(stored, presented)
  );
}

/** @param {unknown} value */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
