// Device registration and refresh. Tokens are scoped to a Site and managed
// device; optional sid selects an independent browser-container session.
// Legacy refresh is single-use. A durable attempt ID enables bounded recovery
// of the same rotation after a lost response or failed local save (ADR 0020).
// Parent liveness and Site/membership authority apply to both paths.

import { checkCodeAttemptLimit } from "./code-attempt-limit.js";
import { normalizeSiteCode } from "./site-code.js";
import {
  retryableRefresh,
  validRefreshAttempt,
} from "../lib/refresh-recovery.js";
import { randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deviceKey } from "./keys.js";
import {
  consumeSetupCodeTransactItem,
  validateSetupCode,
} from "./setup-codes.js";
import { deviceLivenessProblem } from "../lib/device-liveness.js";
import {
  contextSession,
  contextSessionWrite,
  deviceSessionMatches,
} from "../lib/device-context-sessions.js";
import {
  canonicalAccessLevel,
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
 * @property {"general"|"manager"|"admin"} accessLevel
 * @property {string} label
 * @property {string} registeredAt
 * @property {string} lastSeenAt
 * @property {number} tokenGeneration
 * @property {string} refreshJti
 * @property {"active"|"suspended"|"revoked"} [status]
 * @property {string} [absoluteExpiresAt]
 * @property {number} [inactivityLimitDays]
 * @property {string} [membershipId]
 * @property {number} [membershipGeneration]
 * @property {number} [siteCredentialGeneration]
 * @property {string} [handoffGrantId] the pending Home Screen handoff grant (handlers/session-handoff.js)
 * @property {Record<string, any>} [sessions]
 * @property {string} [primarySessionStatus]
 * @property {number} [sessionStartGeneration] stable generation floor for this enrollment
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
    /** @type {{ code?: unknown, deviceId?: unknown, label?: unknown, sessionKind?: unknown }} */ (
      body ?? {}
    );
  const code = typeof raw.code === "string" ? raw.code : "";
  if (!code.trim()) {
    return jsonResponse(400, { error: "missing_site_code" });
  }

  // Cover direct registration as well as the browser's preceding code lookup.
  // Malformed inputs cannot reach a credential lookup and spend no short-code budget.
  if (normalizeSiteCode(code).length !== 6)
    return jsonResponse(401, { error: "invalid_site_code" });
  const limited = await checkCodeAttemptLimit(undefined, "register");
  if (limited) return limited;

  const dynamoTable = getDynamoTableName();
  const now = new Date().toISOString();

  const validCode = await validateSetupCode(code);
  if (!validCode) {
    return jsonResponse(401, { error: "invalid_site_code" });
  }

  // Known device re-registering (idempotent path) — else a fresh opaque id.
  // The item is keyed DEVICE#<providedId>, so item.deviceId === providedId by
  // construction; getDevice only confirms an existing row for that exact key.
  const existing = await getDevice(validCode.siteId, raw.deviceId);
  const deviceId = existing ? existing.deviceId : newDeviceId(raw.deviceId);
  const generation = (existing?.tokenGeneration ?? 0) + 1;
  const accessLevel = canonicalAccessLevel(validCode.accessLevel);
  const [access, refresh] = await Promise.all([
    mintAccessToken({
      siteId: validCode.siteId,
      deviceId,
      tokenGeneration: generation,
      accessLevel,
    }),
    mintRefreshToken({
      siteId: validCode.siteId,
      deviceId,
      tokenGeneration: generation,
      accessLevel,
    }),
  ]);

  const Item = /** @type {DeviceItem} */ ({
    ...deviceKey(validCode.siteId, deviceId),
    type: "device",
    deviceId,
    siteId: validCode.siteId,
    siteName: validCode.siteName,
    accessLevel,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim().slice(0, 100)
        : (existing?.label ?? "Front desk"),
    registeredAt: existing?.registeredAt ?? now,
    lastSeenAt: now,
    tokenGeneration: generation,
    refreshJti: refresh.jti,
    sessionStartGeneration: generation,
    primarySessionKind:
      raw.sessionKind === "home_screen" ? "home_screen" : "browser",
    siteCredentialGeneration: Number(validCode.siteCredentialGeneration ?? 0),
  });

  const consume = consumeSetupCodeTransactItem(validCode, now);
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: dynamoTable,
              Item,
              ConditionExpression: existing
                ? "tokenGeneration = :previousGeneration"
                : "attribute_not_exists(pk)",
              ...(existing && {
                ExpressionAttributeValues: {
                  ":previousGeneration": existing.tokenGeneration,
                },
              }),
            },
          },
          ...(consume ? [consume] : []),
          {
            ConditionCheck: {
              TableName: dynamoTable,
              Key: { pk: `SITE#${validCode.siteId}`, sk: "#META" },
              ConditionExpression:
                "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :inactive) AND (attribute_not_exists(siteCredentialGeneration) OR siteCredentialGeneration = :siteGeneration)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":inactive": "inactive",
                ":siteGeneration": Number(
                  validCode.siteCredentialGeneration ?? 0,
                ),
              },
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "TransactionCanceledException" &&
      isSetupCodeConditionFailure(err, 0)
    )
      return jsonResponse(409, { error: "registration_conflict" });
    if (
      err instanceof Error &&
      err.name === "TransactionCanceledException" &&
      (isSetupCodeConditionFailure(err, consume ? 1 : -1) ||
        isSetupCodeConditionFailure(err, consume ? 2 : 1))
    ) {
      return jsonResponse(401, { error: "invalid_site_code" });
    }
    throw err;
  }

  return jsonResponse(201, {
    deviceId,
    site: { siteId: validCode.siteId, name: validCode.siteName },
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
    accessLevel,
  });
};

/**
 * POST /v1/devices/token:refresh — rotate the session. The refresh token is
 * single-use: it must match the DEVICE# item's current `refreshJti`, and each
 * successful refresh bumps `tokenGeneration` (invalidating the previous access
 * token immediately) and stores the new jti. A replayed refresh token fails the
 * jti comparison; a revoked device fails the generation comparison. With a
 * durable attemptId, a matching spent token may recover its still-current
 * replacement for five minutes; live authority is checked again (ADR 0020).
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const refreshDeviceToken = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const { refreshToken, attemptId } =
    /** @type {{ refreshToken?: unknown, attemptId?: unknown }} */ (body ?? {});
  if (typeof refreshToken !== "string" || !refreshToken) {
    return jsonResponse(400, { error: "missing_refresh_token" });
  }

  if (attemptId !== undefined && !validRefreshAttempt(attemptId)) {
    return jsonResponse(400, { error: "invalid_refresh_attempt" });
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
      ConsistentRead: true,
    }),
  );
  const device = /** @type {DeviceItem | undefined} */ (res.Item);
  const now = new Date();
  const canonicalRole = canonicalAccessLevel(device?.accessLevel);
  if (typeof attemptId === "string") {
    return retryableRefresh({
      tableName: dynamoTable,
      device,
      claims,
      refreshToken,
      attemptId,
      isLive: async (current) =>
        !deviceLivenessProblem(current, new Date()) &&
        canonicalAccessLevel(current.accessLevel) === claims.accessLevel &&
        (await bindingLifecycleValid(
          /** @type {DeviceItem} */ (current),
          canonicalAccessLevel(current.accessLevel),
          undefined,
          true,
        )),
    });
  }

  if (
    !device ||
    deviceLivenessProblem(device, now) || // revoked, suspended, expired, idle
    !deviceSessionMatches(device, claims) ||
    canonicalRole !== claims.accessLevel ||
    !claims.jti ||
    (claims.sid
      ? device.sessions?.[claims.sid]?.refreshJti
      : device.refreshJti) !== claims.jti // already used / superseded
  ) {
    return jsonResponse(401, {
      error: "invalid_refresh_token",
      reason: "revoked_or_replayed",
    });
  }

  const lifecycleValid = await bindingLifecycleValid(device, canonicalRole);
  if (!lifecycleValid) {
    return jsonResponse(401, {
      error: "invalid_refresh_token",
      reason: "revoked_or_replayed",
    });
  }
  const nowIso = now.toISOString();
  if (claims.sid) {
    const generation = claims.ver + 1;
    const subject = {
      siteId,
      deviceId,
      tokenGeneration: generation,
      accessLevel: canonicalRole,
      sessionId: claims.sid,
    };
    const [access, refresh] = await Promise.all([
      mintAccessToken(subject),
      mintRefreshToken(subject),
    ]);
    const slot = contextSession(
      device,
      claims.sid,
      refresh.jti,
      generation,
      nowIso,
    );
    const write = contextSessionWrite(
      dynamoTable,
      device,
      claims.sid,
      slot,
      claims.jti,
    );
    if (!write) return jsonResponse(401, { error: "invalid_refresh_token" });
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [write] }));
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      )
        return jsonResponse(401, {
          error: "invalid_refresh_token",
          reason: "revoked_or_replayed",
        });
      throw error;
    }
    return jsonResponse(200, {
      deviceId,
      site: { siteId, name: device.siteName },
      accessLevel: canonicalRole,
      token: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
      refreshExpiresIn: refresh.expiresIn,
      tokenGeneration: generation,
    });
  }
  // Conditional write: rotation applies ONLY from the observed generation +
  // jti. A concurrent refresh with the same token loses the swap here (one
  // winner) instead of both succeeding via last-write-wins.
  const session = await mintSession({
    siteId,
    deviceId,
    generation: device.tokenGeneration + 1,
    accessLevel: canonicalAccessLevel(device.accessLevel),
    dynamoTable,
    now: nowIso,
    expectGeneration: device.tokenGeneration,
    expectJti: claims.jti,
  });
  if (!session) {
    return jsonResponse(401, {
      error: "invalid_refresh_token",
      reason: "revoked_or_replayed",
    });
  }

  return jsonResponse(200, {
    deviceId,
    site: { siteId, name: device.siteName },
    accessLevel: canonicalAccessLevel(device.accessLevel),
    ...session,
  });
};

/**
 * Recheck Site and Manager membership generations. A generation-less legacy
 * device is generation zero: it remains compatible with an unadvanced Site,
 * but fails closed immediately after any Site-wide generation bump.
 * Shared with handlers/session-handoff.js, which re-mints a session for an
 * existing device and must apply the same answer; it passes the SITE#META
 * row it already read so the check costs no extra round trip.
 * @param {DeviceItem & Record<string, any>} device
 * @param {"general"|"manager"} role
 * @param {Record<string, any> | undefined} [prefetchedSite] the SITE#META row, when the caller has it
 * @param {boolean} [consistentRead] use strongly consistent authority reads for recovery
 * @returns {Promise<boolean>}
 */
export async function bindingLifecycleValid(
  device,
  role,
  prefetchedSite,
  consistentRead = false,
) {
  const tableName = getDynamoTableName();
  const site =
    prefetchedSite ??
    (
      await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${device.siteId}`, sk: "#META" },
          ConsistentRead: consistentRead,
        }),
      )
    ).Item;
  if (
    !site ||
    site.status === "inactive" ||
    Number(site.siteCredentialGeneration ?? 0) !==
      Number(device.siteCredentialGeneration ?? 0)
  ) {
    return false;
  }
  if (role !== "manager") return true;
  if (device.authorityScope === "provider") {
    if (
      !device.providerId ||
      site.providerId !== device.providerId ||
      Number(device.providerAccessGeneration ?? 0) !==
        Number(site.providerAccessGeneration ?? 0)
    )
      return false;
    const membership = await findProviderManager(
      tableName,
      String(device.providerId),
      String(device.providerMembershipId),
      consistentRead,
    );
    return Boolean(
      membership?.status === "active" &&
        Number(membership.generation ?? 0) ===
          Number(device.providerMembershipGeneration ?? -1),
    );
  }
  if (!device.membershipId) return true;
  const membershipResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: {
        pk: `SITE#${device.siteId}`,
        sk: `MANAGER_MEMBERSHIP#${device.membershipId}`,
      },
      ConsistentRead: consistentRead,
    }),
  );
  const membership = membershipResult.Item;
  return Boolean(
    membership?.status === "active" &&
      Number(membership.generation ?? 0) ===
        Number(device.membershipGeneration ?? -1),
  );
}

/** @param {string} tableName @param {string} providerId @param {string} membershipId @param {boolean} [consistentRead] */
async function findProviderManager(
  tableName,
  providerId,
  membershipId,
  consistentRead = false,
) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      ConsistentRead: consistentRead,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `PROVIDER#${providerId}`,
        ":prefix": "PROVIDER_MANAGER#",
      },
    }),
  );
  return (result.Items ?? []).find(
    (item) => String(item.membershipId) === membershipId,
  );
}

/**
 * Mint the access + refresh pair and persist the new session state (generation
 * + refresh jti + lastSeenAt) onto the DEVICE# item — atomically, via a
 * compare-and-swap on the CURRENT generation (+ jti, when expected). The
 * condition — not the earlier read — is what makes the CAS atomic:
 * - refresh passes expected generation + jti: a concurrent/replayed rotation
 *   loses the swap → null → 401.
 * - re-registration passes only the expected generation: a concurrent
 *   re-register/refresh that moved the generation first loses the swap → null
 *   → the caller retries from a fresh read.
 * - fresh registration passes no expected state: the row was just Put, so the
 *   write is unconditional (nothing to race).
 * @param {{ siteId: string, deviceId: string, generation: number, accessLevel: "general"|"manager", dynamoTable: string, now: string, expectGeneration?: number, expectJti?: string }} s
 * @returns {Promise<{ token: string, refreshToken: string, expiresIn: number, refreshExpiresIn: number, tokenGeneration: number } | null>} null when the CAS lost
 */
async function mintSession({
  siteId,
  deviceId,
  generation,
  accessLevel,
  dynamoTable,
  now,
  expectGeneration,
  expectJti,
}) {
  const [access, refresh] = await Promise.all([
    mintAccessToken({
      siteId,
      deviceId,
      tokenGeneration: generation,
      accessLevel,
    }),
    mintRefreshToken({
      siteId,
      deviceId,
      tokenGeneration: generation,
      accessLevel,
    }),
  ]);

  // The CAS condition and its expected-state bindings (:eg/:ej) ride the SAME
  // command as the SET bindings (:g/:jti/:seen/:accessLevel) — one object, so
  // neither side can clobber the other. Persisting accessLevel also migrates
  // pre-access-level DEVICE# records as soon as their session refreshes.
  const conditional = expectGeneration !== undefined;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: dynamoTable,
        Key: { ...deviceKey(siteId, deviceId) },
        UpdateExpression:
          "SET tokenGeneration = :g, refreshJti = :jti, lastSeenAt = :seen, primaryLastSeenAt = :seen, accessLevel = :accessLevel",
        ...(conditional && {
          ConditionExpression: "tokenGeneration = :eg AND refreshJti = :ej",
        }),
        ExpressionAttributeValues: {
          ":g": generation,
          ":jti": refresh.jti,
          ":seen": now,
          ":accessLevel": accessLevel,
          ...(conditional && {
            ":eg": expectGeneration,
            ":ej": expectJti,
          }),
        },
      }),
    );
  } catch (err) {
    // Lost the CAS — a concurrent re-register/refresh rotated the session
    // between the read and this write. Fail closed; callers retry (register)
    // or 401 (refresh).
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      return null;
    }
    throw err;
  }

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
      ConsistentRead: true,
    }),
  );
  const item = /** @type {DeviceItem | undefined} */ (res.Item);
  return item?.deviceId === deviceId ? item : undefined;
}

/**
 * @param {Error & { CancellationReasons?: Array<{ Code?: string }> }} err
 * @param {number} consumeIndex
 * @returns {boolean}
 */
function isSetupCodeConditionFailure(err, consumeIndex) {
  return (
    consumeIndex >= 0 &&
    err.CancellationReasons?.[consumeIndex]?.Code === "ConditionalCheckFailed"
  );
}

/**
 * Accept a caller-supplied id (re-registration) or mint a fresh opaque id.
 * @param {unknown} provided
 * @returns {string}
 */
function newDeviceId(provided) {
  return typeof provided === "string" && provided ? provided : randomUUID();
}
