import { createHmac, randomInt } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { normalizeSiteCode } from "./site-code.js";

const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SETUP_CODE_TTL_MS = 72 * 60 * 60 * 1000;
const SETUP_CODE_MAX_USES = 3;
const GENERIC_REQUEST_MESSAGE =
  "If that email is authorized for this site, we will send a new setup code.";

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** @type {Map<string, string>} */
const setupCodeSecretCache = new Map();

/**
 * @typedef {object} SetupCodeItem
 * @property {string} pk
 * @property {string} sk
 * @property {"setupCode"} type
 * @property {string} codeId
 * @property {string} codeVerifier
 * @property {"pending"|"used"|"revoked"|"expired"} status
 * @property {string} expiresAt
 * @property {number} maxUses
 * @property {number} uses
 * @property {string} siteId
 * @property {string} siteName
 * @property {string} [providerId]
 * @property {string} [providerName]
 * @property {string} [providerSiteId]
 * @property {string} [issuedTo]
 * @property {string} [issuedBy]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {object} LegacySiteCodeItem
 * @property {string} pk
 * @property {string} sk
 * @property {"providerSiteCode"} type
 * @property {string} code
 * @property {boolean} active
 * @property {string} providerSiteId
 * @property {string} siteId
 * @property {string} siteName
 */

/**
 * @typedef {object} ValidSetupCode
 * @property {"setupCode"|"legacy"} kind
 * @property {string} code
 * @property {SetupCodeItem|LegacySiteCodeItem} item
 * @property {string} siteId
 * @property {string} siteName
 * @property {string|undefined} providerSiteId
 */

/**
 * Validate a setup code without consuming one of its allowed bindings.
 * @param {string} rawCode
 * @param {{ now?: Date }} [options]
 * @returns {Promise<ValidSetupCode | null>}
 */
export async function validateSetupCode(rawCode, options = {}) {
  const code = normalizeSiteCode(rawCode);
  if (code.length !== 6) return null;

  const tableName = getDynamoTableName();
  const now = options.now ?? new Date();
  const setup = await getSetupCode(code, tableName);
  if (setup) {
    if (!isSetupCodeUsable(setup, now)) return null;
    return {
      kind: "setupCode",
      code,
      item: setup,
      siteId: setup.siteId,
      siteName: setup.siteName,
      providerSiteId: setup.providerSiteId,
    };
  }

  // Compatibility path for current local/dev seeds while dynamic issuance rolls
  // out. New production codes should use SETUP_CODE# verifier records.
  const legacy = await getLegacySiteCode(code, tableName);
  if (legacy?.active && legacy.siteId && legacy.siteName) {
    return {
      kind: "legacy",
      code,
      item: legacy,
      siteId: legacy.siteId,
      siteName: legacy.siteName,
      providerSiteId: legacy.providerSiteId,
    };
  }

  return null;
}

/**
 * Create a transaction item that consumes one allowed binding from a setup code.
 * Legacy fixed dev codes return null because they do not carry lifecycle state.
 * @param {ValidSetupCode} valid
 * @param {string} nowIso
 * @returns {any}
 */
export function consumeSetupCodeTransactItem(valid, nowIso) {
  if (valid.kind !== "setupCode") return null;
  return {
    Update: {
      TableName: getDynamoTableName(),
      Key: { pk: valid.item.pk, sk: valid.item.sk },
      UpdateExpression:
        "SET uses = uses + :one, updatedAt = :now, lastUsedAt = :now",
      ConditionExpression:
        "#status = :pending AND expiresAt > :now AND uses < maxUses",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":one": 1,
        ":now": nowIso,
        ":pending": "pending",
      },
    },
  };
}

/**
 * Issue a setup code for a site/contact, invalidating any pending code for the
 * same pair before writing the replacement.
 * @param {{ siteId: string, siteName: string, providerId?: string, providerName?: string, providerSiteId?: string, issuedTo: string, issuedBy: string, now?: Date }} input
 * @returns {Promise<{ code: string, item: SetupCodeItem }>}
 */
export async function issueSetupCode(input) {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const code = generateSetupCode();
  const contactHash = await emailHash(input.issuedTo);
  const codeVerifier = await setupCodeVerifier(code);
  const item = /** @type {SetupCodeItem} */ ({
    pk: setupCodePkFromVerifier(codeVerifier),
    sk: "#META",
    type: "setupCode",
    codeId: randomCodeId(),
    codeVerifier,
    status: "pending",
    expiresAt: new Date(now.getTime() + SETUP_CODE_TTL_MS).toISOString(),
    maxUses: SETUP_CODE_MAX_USES,
    uses: 0,
    siteId: input.siteId,
    siteName: input.siteName,
    providerId: input.providerId,
    providerName: input.providerName,
    providerSiteId: input.providerSiteId,
    issuedTo: normalizeEmail(input.issuedTo),
    issuedBy: input.issuedBy,
    createdAt: nowIso,
    updatedAt: nowIso,
    gsi6pk: `SETUP_CODE_PENDING#${input.siteId}#${contactHash}`,
    gsi6sk: nowIso,
  });

  await invalidatePendingSetupCodes({
    siteId: input.siteId,
    issuedTo: input.issuedTo,
    nowIso,
  });
  await ddb.send(
    new PutCommand({
      TableName: getDynamoTableName(),
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return { code, item };
}

/**
 * @param {string} email
 * @returns {string}
 */
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/**
 * @param {string} email
 * @returns {Promise<string>}
 */
export async function emailHash(email) {
  return createHmac("sha256", await verifierSecret())
    .update(normalizeEmail(email))
    .digest("hex");
}

/**
 * @returns {string}
 */
export function genericSetupCodeRequestMessage() {
  return GENERIC_REQUEST_MESSAGE;
}

/**
 * @returns {string}
 */
export function generateSetupCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * @param {string} code
 * @returns {Promise<string>}
 */
export async function setupCodeVerifier(code) {
  return createHmac("sha256", await verifierSecret())
    .update(normalizeSiteCode(code))
    .digest("hex");
}

/**
 * @param {string} code
 * @returns {Promise<string>}
 */
export async function setupCodePk(code) {
  return setupCodePkFromVerifier(await setupCodeVerifier(code));
}

/**
 * @param {string} code
 * @param {string} tableName
 * @returns {Promise<SetupCodeItem | undefined>}
 */
async function getSetupCode(code, tableName) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: await setupCodePk(code), sk: "#META" },
    }),
  );
  return /** @type {SetupCodeItem | undefined} */ (res?.Item);
}

/**
 * @param {string} code
 * @param {string} tableName
 * @returns {Promise<LegacySiteCodeItem | undefined>}
 */
async function getLegacySiteCode(code, tableName) {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `SITE_CODE#${code}`, sk: "#META" },
    }),
  );
  return /** @type {LegacySiteCodeItem | undefined} */ (res?.Item);
}

/**
 * @param {SetupCodeItem} item
 * @param {Date} now
 * @returns {boolean}
 */
function isSetupCodeUsable(item, now) {
  return (
    item.status === "pending" &&
    Boolean(item.siteId) &&
    Boolean(item.siteName) &&
    Date.parse(item.expiresAt) > now.getTime() &&
    item.uses < item.maxUses
  );
}

/**
 * @param {{ siteId: string, issuedTo: string, nowIso: string }} input
 */
async function invalidatePendingSetupCodes({ siteId, issuedTo, nowIso }) {
  const contactHash = await emailHash(issuedTo);
  const res = await ddb.send(
    new QueryCommand({
      TableName: getDynamoTableName(),
      IndexName: "GSI6",
      KeyConditionExpression: "gsi6pk = :pk",
      ExpressionAttributeValues: {
        ":pk": `SETUP_CODE_PENDING#${siteId}#${contactHash}`,
      },
    }),
  );

  await Promise.all(
    (res.Items ?? []).map((item) =>
      ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: {
            ...item,
            status: "revoked",
            revokedReason: "superseded",
            updatedAt: nowIso,
            gsi6pk: undefined,
            gsi6sk: undefined,
          },
        }),
      ),
    ),
  );
}

/**
 * @returns {string}
 */
function randomCodeId() {
  return cryptoRandomFallback();
}

/**
 * @returns {string}
 */
function cryptoRandomFallback() {
  return Array.from({ length: 16 }, () =>
    CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join("");
}

/**
 * @param {string} verifier
 * @returns {string}
 */
function setupCodePkFromVerifier(verifier) {
  return `SETUP_CODE#${verifier}`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function verifierSecret(env = process.env) {
  if (env.SETUP_CODE_VERIFIER_SECRET) return env.SETUP_CODE_VERIFIER_SECRET;
  if (env.DEVICE_TOKEN_SECRET) return env.DEVICE_TOKEN_SECRET;

  const secretArn = env.DEVICE_TOKEN_SECRET_SECRET_ARN;
  if (secretArn) {
    const cached = setupCodeSecretCache.get(secretArn);
    if (cached) return cached;

    secretsClient ??= new SecretsManagerClient({});
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const value = res.SecretString;
    if (!value) {
      throw new Error(
        `Setup-code verifier secret ${secretArn} has no SecretString value`,
      );
    }
    setupCodeSecretCache.set(secretArn, value);
    return value;
  }

  throw new Error(
    "No setup-code verifier secret configured: set SETUP_CODE_VERIFIER_SECRET (local) or DEVICE_TOKEN_SECRET_SECRET_ARN (deployed)",
  );
}

/** Drop the cached setup-code verifier secret so a subsequent call re-fetches. */
export function resetSetupCodeSecretCache() {
  setupCodeSecretCache.clear();
}
