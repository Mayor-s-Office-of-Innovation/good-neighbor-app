// Mint + verify the device session tokens (Option 4 device auth — see
// docs/adr/0010-device-token-auth.md). HS256 JWTs implemented on node:crypto —
// no third-party JWT dependency, deterministic, and bundle-safe.
//
// Two token kinds, both carrying the SAME claim shape the handlers already read:
//   access  — { sub: <deviceId>, "custom:siteId": <siteId>, ver, typ:"access", iat, exp }
//   refresh — { sub: <deviceId>, "custom:siteId": <siteId>, ver, typ:"refresh", jti, iat, exp }
// The `custom:siteId` key mirrors the Cognito claim contract (backend/src/lib/principal.js),
// so swapping the issuer later is invisible to every handler. The signing key is a
// server-side credential: env-provided locally, Secrets Manager in deployed envs
// (same seam as analysis/api-key.js). Never logged, never shipped to the client.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — long-lived by design
const REFRESH_TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days — rotated on use

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** Module-scope cache of the signing key, keyed by secret ARN. @type {Map<string, string>} */
const keyCache = new Map();

/**
 * The HS256 signing key. `DEVICE_TOKEN_SECRET` covers local runs and tests;
 * deployed envs hold it in Secrets Manager (`DEVICE_TOKEN_SECRET_SECRET_ARN`),
 * fetched once and cached at module scope.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function getDeviceTokenSecret(env = process.env) {
  if (env.DEVICE_TOKEN_SECRET) return env.DEVICE_TOKEN_SECRET;

  const secretArn = env.DEVICE_TOKEN_SECRET_SECRET_ARN;
  if (secretArn) {
    const cached = keyCache.get(secretArn);
    if (cached) return cached;

    secretsClient ??= new SecretsManagerClient({});
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    // The secret holds the raw key string (set out-of-band via
    // `aws secretsmanager put-secret-value`); never written by Terraform.
    const value = res.SecretString;
    if (!value) {
      throw new Error(
        `Device token secret ${secretArn} has no SecretString value`,
      );
    }
    keyCache.set(secretArn, value);
    return value;
  }

  throw new Error(
    "No device token secret configured: set DEVICE_TOKEN_SECRET (local) or DEVICE_TOKEN_SECRET_SECRET_ARN (deployed)",
  );
}

/** Drop the cached key so a subsequent call re-fetches (after a rotation). */
export function resetDeviceTokenSecretCache() {
  keyCache.clear();
}

/**
 * @typedef {object} DeviceTokenSubject
 * @property {string} siteId
 * @property {string} deviceId
 * @property {number} tokenGeneration
 */

/**
 * @typedef {object} MintedToken
 * @property {string} token
 * @property {number} expiresIn  seconds
 */

/**
 * Mint an access token for a device session.
 * @param {DeviceTokenSubject} subject
 * @param {{ expiresIn?: number, now?: number, secret?: string }} [opts]
 * @returns {Promise<MintedToken>}
 */
export async function mintAccessToken(
  { siteId, deviceId, tokenGeneration },
  opts = {},
) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expiresIn = opts.expiresIn ?? ACCESS_TTL_SECONDS;
  const token = await signJwt(
    {
      sub: deviceId,
      "custom:siteId": siteId,
      ver: tokenGeneration,
      typ: "access",
      iat: now,
      exp: now + expiresIn,
    },
    opts,
  );
  return { token, expiresIn };
}

/**
 * Mint a refresh token (long-lived; single-use — the handler rotates it).
 * @param {DeviceTokenSubject} subject
 * @param {{ expiresIn?: number, now?: number, secret?: string }} [opts]
 * @returns {Promise<MintedToken & { jti: string }>}
 */
export async function mintRefreshToken(
  { siteId, deviceId, tokenGeneration },
  opts = {},
) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const expiresIn = opts.expiresIn ?? REFRESH_TTL_SECONDS;
  const jti = randomBytes(24).toString("base64url");
  const token = await signJwt(
    {
      sub: deviceId,
      "custom:siteId": siteId,
      ver: tokenGeneration,
      typ: "refresh",
      jti,
      iat: now,
      exp: now + expiresIn,
    },
    opts,
  );
  return { token, expiresIn, jti };
}

/**
 * The verified device-token claims. `siteId` mirrors the Cognito
 * `custom:siteId` claim; on the wire the JWT carries the `"custom:siteId"` key
 * (Cognito-compatible), which this typedef names `siteId` for readable access.
 * @typedef {object} DeviceClaims
 * @property {string} sub           deviceId
 * @property {string} siteId        tenant partition binding (wire: "custom:siteId")
 * @property {number} ver           tokenGeneration the token was minted against
 * @property {"access" | "refresh"} typ
 * @property {number} iat
 * @property {number} exp
 * @property {string} [jti]         refresh tokens only
 */

/**
 * Verify a token's signature + expiry and return its claims.
 * @param {string} token
 * @param {{ now?: number, secret?: string }} [opts]
 * @returns {Promise<DeviceClaims>}
 * @throws {DeviceTokenError} expired / malformed / bad_signature / not_configured
 */
export async function verifyDeviceToken(token, opts = {}) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3) {
    throw new DeviceTokenError("malformed", "not a three-part JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  /** @type {any} */
  let header;
  try {
    header = JSON.parse(b64urlDecode(headerB64));
  } catch {
    throw new DeviceTokenError("malformed", "undecodable header");
  }
  if (header?.alg !== "HS256" || header?.typ !== "JWT") {
    throw new DeviceTokenError("malformed", "unsupported JWT header");
  }

  const secret = opts.secret ?? (await getDeviceTokenSecret());
  const expected = hmac(secret, `${headerB64}.${payloadB64}`);
  const provided = safeBase64Decode(signatureB64);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new DeviceTokenError("bad_signature", "signature mismatch");
  }

  /** @type {Record<string, unknown>} */
  let claims;
  try {
    claims = JSON.parse(b64urlDecode(payloadB64));
  } catch {
    throw new DeviceTokenError("malformed", "undecodable payload");
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (typeof claims?.exp !== "number" || claims.exp <= now) {
    throw new DeviceTokenError("expired", "token expired");
  }
  if (
    typeof claims?.sub !== "string" ||
    typeof claims?.["custom:siteId"] !== "string" ||
    typeof claims?.ver !== "number"
  ) {
    throw new DeviceTokenError("malformed", "missing required claims");
  }
  if (claims.typ !== "access" && claims.typ !== "refresh") {
    throw new DeviceTokenError("malformed", "unknown token type");
  }
  // Project the wire shape (Cognito's `custom:siteId`) onto the typed view.
  return /** @type {DeviceClaims} */ ({
    ...claims,
    siteId: claims["custom:siteId"],
  });
}

/**
 * @param {Record<string, unknown>} claims
 * @param {{ expiresIn?: number, now?: number, secret?: string }} opts
 * @returns {Promise<string>}
 */
async function signJwt(claims, { secret } = {}) {
  const headerB64 = b64urlEncode({ alg: "HS256", typ: "JWT" });
  const payloadB64 = b64urlEncode(claims);
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = secret ?? (await getDeviceTokenSecret());
  const signature = hmac(key, signingInput);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * @param {string} secret
 * @param {string} input
 * @returns {Buffer}
 */
function hmac(secret, input) {
  return createHmac("sha256", secret).update(input).digest();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function b64urlEncode(value) {
  return b64url(Buffer.from(JSON.stringify(value), "utf8"));
}

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function b64url(buf) {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * @param {string} s
 * @returns {string}
 */
function b64urlDecode(s) {
  return Buffer.from(s, "base64").toString("utf8");
}

/**
 * @param {string} s
 * @returns {Buffer}
 */
function safeBase64Decode(s) {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(b64, "base64");
}

/** Typed verify failure so callers can 401 without string-matching. */
export class DeviceTokenError extends Error {
  /**
   * @param {"expired" | "bad_signature" | "malformed" | "not_configured"} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`device token ${code}: ${detail}`);
    this.name = "DeviceTokenError";
    this.code = code;
  }
}
