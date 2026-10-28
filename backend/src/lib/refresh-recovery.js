// One encrypted, bounded receipt per session. The old signed refresh token AND
// the client's durable attempt ID are required; neither alone recovers a pair.
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import {
  getDeviceTokenSecret,
  mintAccessToken,
  mintRefreshToken,
  canonicalAccessLevel,
} from "./device-token.js";
import {
  deviceSessionMatches,
  contextSession,
  contextSessionWrite,
} from "./device-context-sessions.js";
import { sessionRotationItem } from "./device-session.js";

export const RECOVERY_SECONDS = 300;
export const validRefreshAttempt = (/** @type {unknown} */ value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
const digest = (/** @type {string} */ value) =>
  createHash("sha256").update(value).digest("hex");
const rejected = () =>
  jsonResponse(401, {
    error: "invalid_refresh_token",
    reason: "revoked_or_replayed",
  });

/**
 * @param {{tableName: string, device: Record<string, any> | undefined, claims: import('./device-token.js').DeviceClaims, refreshToken: string, attemptId: string, isLive: (device: Record<string, any>) => Promise<boolean>}} input
 */
export async function retryableRefresh({
  tableName,
  device,
  claims,
  refreshToken,
  attemptId,
  isLive,
}) {
  const key = { pk: `SITE#${claims.siteId}`, sk: `DEVICE#${claims.sub}` };
  const inputHash = digest(refreshToken);
  const attemptHash = digest(attemptId);
  const aad = Buffer.from(
    JSON.stringify([claims.siteId, claims.sub, claims.sid ?? ""]),
  );
  const encryptionKey = createHash("sha256")
    .update("gnp:refresh-recovery:v1\0")
    .update(await getDeviceTokenSecret())
    .digest();
  const stateOf = (/** @type {Record<string, any>} */ value) =>
    claims.sid ? value.sessions?.[claims.sid] : value;
  const read = async () =>
    (
      await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item;
  /** @param {Record<string, any> | undefined} current */
  async function recover(current) {
    if (!current || !(await isLive(current))) return rejected();
    const state = stateOf(current);
    const receipt = state?.refreshRecovery;
    const now = Math.floor(Date.now() / 1000);
    if (
      !receipt ||
      receipt.inputHash !== inputHash ||
      receipt.attemptHash !== attemptHash ||
      receipt.inputGeneration !== claims.ver ||
      now >= receipt.expiresAt ||
      state.refreshJti !== receipt.nextJti ||
      !deviceSessionMatches(current, { ...claims, ver: receipt.nextGeneration })
    )
      return rejected();
    let payload;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        Buffer.from(receipt.iv, "base64url"),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(receipt.tag, "base64url"));
      payload = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(receipt.ciphertext, "base64url")),
          decipher.final(),
        ]).toString(),
      );
    } catch {
      return rejected();
    }
    if (
      payload.issuedAt !== receipt.issuedAt ||
      now >= payload.issuedAt + RECOVERY_SECONDS ||
      payload.session.tokenGeneration !== receipt.nextGeneration
    )
      return rejected();
    const elapsed = Math.max(0, now - payload.issuedAt);
    return jsonResponse(200, {
      ...payload.session,
      expiresIn: Math.max(0, payload.session.expiresIn - elapsed),
      refreshExpiresIn: Math.max(0, payload.session.refreshExpiresIn - elapsed),
    });
  }
  if (!device || !(await isLive(device))) return rejected();
  const state = stateOf(device);
  if (
    !claims.jti ||
    !deviceSessionMatches(device, claims) ||
    state?.refreshJti !== claims.jti
  )
    return recover(device);
  // An attempt identifies one rotation, not a permanent reusable client ID.
  if (state.refreshRecovery?.attemptHash === attemptHash) return rejected();
  const now = Math.floor(Date.now() / 1000);
  const nowIso = new Date(now * 1000).toISOString();
  const generation = claims.ver + 1;
  const subject = {
    siteId: claims.siteId,
    deviceId: claims.sub,
    sessionId: claims.sid,
    tokenGeneration: generation,
    accessLevel: canonicalAccessLevel(device.accessLevel),
  };
  const [access, refresh] = await Promise.all([
    mintAccessToken(subject, { now }),
    mintRefreshToken(subject, { now }),
  ]);
  const payload = {
    deviceId: claims.sub,
    site: { siteId: claims.siteId, name: device.siteName },
    accessLevel: subject.accessLevel,
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ issuedAt: now, session: payload })),
    cipher.final(),
  ]);
  const receipt = {
    inputHash,
    attemptHash,
    inputGeneration: claims.ver,
    nextGeneration: generation,
    nextJti: refresh.jti,
    issuedAt: now,
    expiresAt: now + RECOVERY_SECONDS,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  const write = claims.sid
    ? contextSessionWrite(
        tableName,
        device,
        claims.sid,
        {
          ...contextSession(
            device,
            claims.sid,
            refresh.jti,
            generation,
            nowIso,
          ),
          refreshRecovery: receipt,
        },
        claims.jti,
      )
    : sessionRotationItem(tableName, device, {
        generation,
        refreshJti: refresh.jti,
        now: nowIso,
      });
  if (!write) return rejected();
  if (!claims.sid) {
    write.Update.UpdateExpression += ", refreshRecovery = :receipt";
    write.Update.ConditionExpression += " AND refreshJti = :expectedJti";
    Object.assign(write.Update.ExpressionAttributeValues, {
      ":receipt": receipt,
      ":expectedJti": claims.jti,
    });
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: [write] }));
    return jsonResponse(200, payload);
  } catch (error) {
    if (
      !(error instanceof Error && error.name === "TransactionCanceledException")
    )
      throw error;
    // A transaction conflict can arrive before the winning transaction commits.
    // Keep that case retryable rather than misclassifying it as revoked.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await read();
      if (
        !current ||
        !deviceSessionMatches(current, claims) ||
        stateOf(current)?.refreshJti !== claims.jti
      )
        return recover(current);
      if (!(await isLive(current))) return rejected();
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
    return jsonResponse(409, { error: "refresh_in_progress" });
  }
}
