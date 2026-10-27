// Home Screen session bootstrap (docs/adr/0019-home-screen-session-continuity.md).
// A single-use grant is copied into the installed app through a Secure,
// HttpOnly, SameSite=Strict cookie. The manifest fragment remains a fallback.
// Redemption adds an independent session slot to the existing device. Safari's
// generation/JTI and every managed binding and enrollment identity stay intact.
// Only the grant hash is stored server-side. Never log tokens, request bodies,
// Cookie or Set-Cookie headers.
//
// One pending grant per device is enforced by a pointer, not by status
// writes: `handoffGrantId` on the DEVICE# row names the only redeemable
// grant. Issue replaces the pointer (conditioned on the previous value, so
// two concurrent issues cannot both win) and redeem requires it, so an
// older grant item simply sits `pending` and unredeemable until the table
// TTL reclaims it. `expiresAt` is stored as EPOCH SECONDS for that TTL
// (attribute `expiresAt`, numeric only); enrollment grants store ISO strings
// there and are never auto-deleted. Don't copy that.

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
import { handoffCookie, readHandoffCookie } from "../lib/handoff-cookie.js";
import {
  contextSession,
  contextSessionWrite,
} from "../lib/device-context-sessions.js";
import {
  canonicalAccessLevel,
  mintAccessToken,
  mintRefreshToken,
} from "../lib/device-token.js";
import {
  deriveActorId,
  deriveSiteId,
  deriveSessionId,
} from "../lib/principal.js";
import { bindingLifecycleValid } from "./devices.js";
import { deviceKey, sitePk } from "./keys.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Pending-grant lifetime. A knob, not a principle (plan § Backend). */
export const HANDOFF_TTL_SECONDS = 7 * 24 * 60 * 60;
// The client (frontend services/session-handoff.js) parses what `startUrl`
// emits; the names live here and there, nowhere else.
const HANDOFF_GRANT_PARAM = "handoff_grant";
const HANDOFF_TOKEN_PARAM = "handoff_token";

const INVALID_GRANT = { error: "invalid_handoff_grant" };
const INVALID_DEVICE = { error: "invalid_device_binding" };

/** @param {string} grantId */
const grantKey = (grantId) => ({
  pk: `SESSION_HANDOFF#${grantId}`,
  sk: "#META",
});

/**
 * Build the start URL the installed app launches at.
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
      Key: deviceKey(siteId, deviceId),
      ConsistentRead: true,
    }),
  );
  const device = deviceResult.Item;
  const sourceSessionId = deriveSessionId(event);
  const sourceSession = sourceSessionId
    ? device?.sessions?.[sourceSessionId]
    : null;
  if (
    !device ||
    deviceLivenessProblem(device, now) ||
    (sourceSessionId
      ? sourceSession?.status !== "active" ||
        Date.parse(sourceSession.expiresAt) <= now.getTime()
      : device.primarySessionStatus === "signed_out")
  ) {
    return jsonResponse(401, INVALID_DEVICE);
  }

  // Reinstall a cached pending grant's HttpOnly cookie on a returning Safari
  // page. Never replace a still-pending grant merely because the tab reopened.
  let input;
  try {
    input = /** @type {Record<string, unknown>} */ (readJsonBody(event) ?? {});
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const cachedId = clean(input.grantId);
  const cachedToken = clean(input.token);
  if (cachedId && cachedToken && device.handoffGrantId === cachedId) {
    const cached = (
      await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: grantKey(cachedId),
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (
      cached?.status === "pending" &&
      cached.siteId === siteId &&
      cached.deviceId === deviceId &&
      (cached.sourceSessionId ?? "") === sourceSessionId &&
      Number(cached.expiresAt) > Math.floor(now.getTime() / 1000) + 86400 &&
      hashMatches(String(cached.tokenHash ?? ""), cachedToken)
    ) {
      return issuedResponse(cachedId, cachedToken, Number(cached.expiresAt));
    }
  }

  const grantId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Math.floor(now.getTime() / 1000) + HANDOFF_TTL_SECONDS;
  const previousGrantId =
    typeof device.handoffGrantId === "string" && device.handoffGrantId
      ? device.handoffGrantId
      : null;

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
                ...(sourceSessionId ? { sourceSessionId } : {}),
                ...(device.bindingId ? { bindingId: device.bindingId } : {}),
                tokenHash: sha256(token),
                status: "pending",
                issuedAt: nowIso,
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
              // Legacy setup-code devices carry no `status`. The pointer
              // condition makes concurrent issues fail closed instead of
              // leaving an untracked pending grant behind.
              ConditionExpression:
                "attribute_exists(pk) AND tokenGeneration = :generation AND (attribute_not_exists(#status) OR #status = :active) AND " +
                (previousGrantId
                  ? "handoffGrantId = :previous"
                  : "attribute_not_exists(handoffGrantId)"),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":grantId": grantId,
                ":generation": device.tokenGeneration,
                ":active": "active",
                ...(previousGrantId ? { ":previous": previousGrantId } : {}),
              },
            },
          },
          auditItem(tableName, siteId, nowIso, {
            eventType: "session_handoff_issued",
            deviceId,
            ...(device.bindingId ? { bindingId: device.bindingId } : {}),
            grantId,
            ...(previousGrantId ? { supersededGrantId: previousGrantId } : {}),
          }),
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

  return issuedResponse(grantId, token, expiresAt);
};

/**
 * POST /app/v1/session-handoff/redeem — exchange a pending grant for a fresh
 * installation for the device it was issued for. Open route: grant rejection is the
 * same 401 so the response never distinguishes unknown, expired, replayed,
 * superseded, and revoked.
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
  const cookie = readHandoffCookie(event);
  const grantId = clean(input.grantId ?? cookie.grantId);
  const token = clean(input.token ?? cookie.token);
  if (!grantId || !token) return jsonResponse(401, INVALID_GRANT);

  const tableName = getDynamoTableName();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const grantResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: grantKey(grantId),
      ConsistentRead: true,
    }),
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
  const [deviceResult, bindingResult, siteResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: deviceKey(siteId, deviceId),
        ConsistentRead: true,
      }),
    ),
    bindingId
      ? ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: sitePk(siteId), sk: `DEVICE_BINDING#${bindingId}` },
            ConsistentRead: true,
          }),
        )
      : Promise.resolve({ Item: undefined }),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: sitePk(siteId), sk: "#META" },
        ConsistentRead: true,
      }),
    ),
  ]);
  const device = deviceResult.Item;
  const binding = bindingResult.Item;
  // The binding row's lastSeenAt only moves on enrollment and select (refresh
  // touches the DEVICE# row), so its liveness is status only — the idle and
  // absolute-expiry clocks are read from the device row, as everywhere else.
  if (
    !device ||
    deviceLivenessProblem(device, now) ||
    device.handoffGrantId !== grantId || // superseded by a newer issue
    (bindingId && binding?.status !== "active") ||
    (grant.sourceSessionId
      ? device.sessions?.[grant.sourceSessionId]?.status !== "active" ||
        Date.parse(device.sessions?.[grant.sourceSessionId]?.expiresAt) <=
          now.getTime()
      : device.primarySessionStatus === "signed_out")
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
      siteResult.Item,
    ))
  ) {
    return jsonResponse(401, INVALID_GRANT);
  }

  const sessionId = randomUUID();
  const generation = 1;
  const subject = {
    siteId,
    deviceId,
    sessionId,
    tokenGeneration: generation,
    accessLevel,
  };
  const [access, refresh] = await Promise.all([
    mintAccessToken(subject, { expiresIn: ACCESS_TTL_SECONDS }),
    mintRefreshToken(subject, { expiresIn: REFRESH_TTL_SECONDS }),
  ]);
  const slot = contextSession(
    device,
    sessionId,
    refresh.jti,
    generation,
    nowIso,
  );
  const write = contextSessionWrite(tableName, device, sessionId, slot);
  if (!write) return jsonResponse(409, { error: "handoff_session_limit" });
  write.Update.UpdateExpression += " REMOVE handoffGrantId";
  write.Update.ConditionExpression += " AND handoffGrantId = :grant";
  write.Update.ExpressionAttributeValues[":grant"] = grantId;

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          write,
          ...(binding
            ? [
                {
                  ConditionCheck: {
                    TableName: tableName,
                    Key: { pk: binding.pk, sk: binding.sk },
                    ConditionExpression: "#status = :active",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: { ":active": "active" },
                  },
                },
              ]
            : []),
          {
            Update: {
              TableName: tableName,
              Key: grantKey(grantId),
              UpdateExpression: "SET #status = :redeemed, redeemedAt = :now",
              ConditionExpression:
                "#status = :pending AND expiresAt > :nowSeconds",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":redeemed": "redeemed",
                ":now": nowIso,
                ":nowSeconds": nowSeconds,
              },
            },
          },
          auditItem(tableName, siteId, nowIso, {
            eventType: "session_handed_off",
            deviceId,
            ...(bindingId ? { bindingId } : {}),
            grantId,
            sessionId,
            tokenGeneration: generation,
          }),
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

  const response = jsonResponse(200, {
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
  response.headers = { ...response.headers, "set-cookie": handoffCookie() };
  return response;
};

/**
 * DELETE /app/v1/session-handoff — retire the calling device's pending grant
 * (sign-out in Safari). Dropping the pointer is what makes the grant
 * unredeemable; the grant row's status is updated best-effort for the audit
 * trail. Authorized, so it runs BEFORE the client clears its session.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const retireSessionHandoff = async (event) => {
  const authorizedEvent =
    /** @type {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} */ (
      /** @type {unknown} */ (event)
    );
  const siteId = deriveSiteId(authorizedEvent);
  const deviceId = deriveActorId(authorizedEvent);
  const tableName = getDynamoTableName();
  const nowIso = new Date().toISOString();

  const deviceResult = await ddb.send(
    new GetCommand({ TableName: tableName, Key: deviceKey(siteId, deviceId) }),
  );
  const device = deviceResult.Item;
  let retirement;
  try {
    retirement = /** @type {Record<string, unknown>} */ (
      readJsonBody(event) ?? {}
    );
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  if (retirement.endSession === true && device) {
    const sessionId = deriveSessionId(event);
    let update;
    if (sessionId) {
      const slot = device.sessions?.[sessionId];
      if (!slot || slot.status !== "active") return retiredResponse(false);
      update = contextSessionWrite(tableName, device, sessionId, {
        ...slot,
        status: "signed_out",
        refreshJti: "",
        tokenGeneration: slot.tokenGeneration + 1,
      });
    } else {
      update = {
        Update: {
          TableName: tableName,
          Key: deviceKey(siteId, deviceId),
          UpdateExpression:
            "SET tokenGeneration = :next, primarySessionStatus = :signedOut REMOVE handoffGrantId",
          ConditionExpression:
            "attribute_exists(pk) AND tokenGeneration = :current",
          ExpressionAttributeValues: {
            ":next": Number(device.tokenGeneration ?? 0) + 1,
            ":current": device.tokenGeneration,
            ":signedOut": "signed_out",
          },
        },
      };
    }
    if (!update) return retiredResponse(false);
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            update,
            auditItem(tableName, siteId, nowIso, {
              eventType: "device_session_signed_out",
              deviceId,
              ...(sessionId ? { sessionId } : {}),
            }),
          ],
        }),
      );
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          error.name === "TransactionCanceledException"
        )
      )
        throw error;
    }
    return retiredResponse(!sessionId && Boolean(device.handoffGrantId));
  }
  const grantId =
    typeof device?.handoffGrantId === "string" ? device.handoffGrantId : "";
  if (!device || !grantId) return retiredResponse(false);

  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: device.pk, sk: device.sk },
              UpdateExpression: "REMOVE handoffGrantId",
              ConditionExpression: "handoffGrantId = :grantId",
              ExpressionAttributeValues: { ":grantId": grantId },
            },
          },
          auditItem(tableName, siteId, nowIso, {
            eventType: "session_handoff_retired",
            deviceId,
            ...(device.bindingId ? { bindingId: device.bindingId } : {}),
            grantId,
          }),
        ],
      }),
    );
  } catch (error) {
    // The pointer moved meanwhile (a concurrent issue or redeem): nothing of
    // ours is left to retire.
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      return retiredResponse(false);
    }
    throw error;
  }

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: grantKey(grantId),
        UpdateExpression: "SET #status = :retired, retiredAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":retired": "retired",
          ":pending": "pending",
          ":now": nowIso,
        },
      }),
    );
  } catch (error) {
    // Already redeemed, or reclaimed by TTL: the pointer is gone either way.
    if (
      !(
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
    ) {
      throw error;
    }
  }
  return retiredResponse(true);
};

/** @param {string} grantId @param {string} token @param {number} expiresAt */
function issuedResponse(grantId, token, expiresAt) {
  const response = jsonResponse(200, {
    grantId,
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    startUrl: handoffStartUrl(grantId, token),
  });
  response.headers = {
    ...response.headers,
    "set-cookie": handoffCookie(
      `${grantId}.${token}`,
      Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
    ),
  };
  return response;
}

/** @param {boolean} retired */
function retiredResponse(retired) {
  const response = jsonResponse(200, { retired });
  response.headers = { ...response.headers, "set-cookie": handoffCookie() };
  return response;
}

/**
 * A site audit event item, same shape as `device_binding_selected`.
 * @param {string} tableName
 * @param {string} siteId
 * @param {string} nowIso
 * @param {Record<string, unknown> & { eventType: string, deviceId: string }} fields
 */
function auditItem(tableName, siteId, nowIso, fields) {
  return {
    Put: {
      TableName: tableName,
      Item: {
        pk: sitePk(siteId),
        sk: `AUDIT#${nowIso}#${randomUUID()}`,
        type: "siteAuditEvent",
        siteId,
        actor: `device:${fields.deviceId}`,
        createdAt: nowIso,
        ...fields,
      },
    },
  };
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
