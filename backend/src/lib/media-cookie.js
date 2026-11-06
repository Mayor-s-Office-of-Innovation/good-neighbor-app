// CloudFront signed cookies for check media (notes/media-signed-cookies-plan.md,
// infra/modules/app/media.tf). Card photos are plain `/checks/<site>/...` paths
// on the app origin, the object key itself; the edge admits them only with these cookies, which
// the api Lambda mints for the caller's own site prefix and renews on every
// token refresh. No per-photo signing request, and the browser can cache the
// bytes because the URL never changes.
//
// The feature is on only when Terraform wired a key pair into this function
// (`MEDIA_KEY_PAIR_ID`). Everything here degrades to "off": no paths on the
// lists, no cookies on the session routes, and the S3 presign route carries on.
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createSign } from "node:crypto";

/** One hour, matching the presigned-URL exposure it replaces (Aaron, 2026-11-05). */
export const MEDIA_COOKIE_TTL_SECONDS = 3600;
/** Check media lives at its object key on the app origin; the cookie covers that tree. */
export const MEDIA_COOKIE_PATH = "/checks";
const COOKIE_NAMES = /** @type {const} */ ([
  "CloudFront-Policy",
  "CloudFront-Signature",
  "CloudFront-Key-Pair-Id",
]);

/** @type {SecretsManagerClient | undefined} */
let secretsClient;
/** Module-scope cache of the private key PEM, keyed by secret ARN. @type {Map<string, string>} */
const keyCache = new Map();

/**
 * Whether this deployment serves media behind signed cookies.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function mediaCookiesEnabled(env = process.env) {
  return Boolean(
    env.MEDIA_KEY_PAIR_ID &&
      (env.MEDIA_SIGNING_KEY || env.MEDIA_SIGNING_KEY_SECRET_ARN) &&
      env.PROVIDER_APP_URL,
  );
}

/**
 * Viewer paths for one artifact row, or nothing when the feature is off or the
 * row's keys fall outside the caller's tenant prefix (stored data is untrusted,
 * the same rule `presignMedia` applies). The display variant of a task-update
 * photo stands in for the original exactly as the presign route does.
 * @param {Record<string, any> | undefined} artifact
 * @param {{ siteId: string, checkId: string, env?: NodeJS.ProcessEnv }} scope
 * @returns {{ mediaPath?: string, thumbnailPath?: string }}
 */
export function mediaPathsFor(
  artifact,
  { siteId, checkId, env = process.env },
) {
  if (!artifact || !mediaCookiesEnabled(env)) return {};
  if (!String(artifact.contentType || "").startsWith("image/")) return {};
  const tenantPrefix = `checks/${siteId}/${checkId}/`;
  /** @param {unknown} key */
  const pathFor = (key) =>
    typeof key === "string" &&
    key.startsWith(tenantPrefix) &&
    !key.includes("..")
      ? `/${key}`
      : undefined;
  const original =
    artifact.entityType === "task_update_media" &&
    typeof artifact.displayS3Key === "string" &&
    artifact.displayS3Key === `${artifact.s3Key}.display.jpg`
      ? artifact.displayS3Key
      : artifact.s3Key;
  const mediaPath = pathFor(original);
  if (!mediaPath) return {};
  const thumbnailPath = pathFor(artifact.thumbS3Key);
  return thumbnailPath ? { mediaPath, thumbnailPath } : { mediaPath };
}

/**
 * The RSA private key PEM. `MEDIA_SIGNING_KEY` covers local runs and tests;
 * deployed environments hold it in Secrets Manager, fetched once per execution
 * environment. A rotation changes `MEDIA_KEY_PAIR_ID` too, which redeploys the
 * function and so empties this cache.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function getMediaSigningKey(env = process.env) {
  if (env.MEDIA_SIGNING_KEY) return env.MEDIA_SIGNING_KEY;
  const secretArn = env.MEDIA_SIGNING_KEY_SECRET_ARN;
  if (!secretArn) throw new Error("No media signing key configured");
  const cached = keyCache.get(secretArn);
  if (cached) return cached;
  secretsClient ??= new SecretsManagerClient({});
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!res.SecretString)
    throw new Error(`Media signing secret ${secretArn} has no SecretString`);
  keyCache.set(secretArn, res.SecretString);
  return res.SecretString;
}

/** Drop the cached key (tests, rotation drills). */
export function resetMediaSigningKeyCache() {
  keyCache.clear();
}

/**
 * CloudFront's URL-safe base64: `+` → `-`, `=` → `_`, `/` → `~`.
 * @param {Buffer | string} input
 */
function cloudFrontBase64(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("=", "_")
    .replaceAll("/", "~");
}

/**
 * The custom policy for one site: every object under that site's check prefix
 * on the app origin, until `expiresAt` (epoch seconds).
 * @param {{ siteId: string, origin: string, expiresAt: number }} input
 */
export function mediaPolicy({ siteId, origin, expiresAt }) {
  return JSON.stringify({
    Statement: [
      {
        Resource: `${origin}${MEDIA_COOKIE_PATH}/${siteId}/*`,
        Condition: { DateLessThan: { "AWS:EpochTime": expiresAt } },
      },
    ],
  });
}

/**
 * The three `Set-Cookie` values for `siteId`, or an empty list when the feature
 * is off. Signing is RSA-SHA1 over the policy bytes, as CloudFront requires.
 * The cookies are scoped to the media path so they never travel to the API,
 * `HttpOnly` so scripts cannot read them, and `SameSite=Strict`: image loads
 * from the app's own documents are same-site however the user arrived.
 * @param {string} siteId
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function mintMediaCookies(
  siteId,
  { env = process.env, now = Date.now() } = {},
) {
  if (!mediaCookiesEnabled(env)) return [];
  if (!/^[\w-]+$/.test(siteId))
    throw new Error("Unsafe siteId for media policy");
  const origin = String(env.PROVIDER_APP_URL).replace(/\/+$/, "");
  const expiresAt = Math.floor(now / 1000) + MEDIA_COOKIE_TTL_SECONDS;
  const policy = mediaPolicy({ siteId, origin, expiresAt });
  const signer = createSign("RSA-SHA1");
  signer.update(policy);
  const signature = signer.sign(await getMediaSigningKey(env));
  const values = {
    "CloudFront-Policy": cloudFrontBase64(policy),
    "CloudFront-Signature": cloudFrontBase64(signature),
    "CloudFront-Key-Pair-Id": String(env.MEDIA_KEY_PAIR_ID),
  };
  const attributes = `Path=${MEDIA_COOKIE_PATH}; Max-Age=${MEDIA_COOKIE_TTL_SECONDS}; Secure; HttpOnly; SameSite=Strict`;
  return COOKIE_NAMES.map((name) => `${name}=${values[name]}; ${attributes}`);
}

/**
 * Attach media cookies to a session response (HTTP API payload 2.0 carries
 * them in `cookies`). Best effort: a signing failure is logged and the session
 * response goes out without cookies, so sign-in never depends on this path;
 * the client falls back to the presign route for photos.
 * @template {{ statusCode: number }} R
 * @param {R} response
 * @param {string} siteId
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [options]
 * @returns {Promise<R & { cookies?: string[] }>}
 */
export async function withMediaCookies(response, siteId, options = {}) {
  const env = options.env ?? process.env;
  const result = /** @type {R & { cookies?: string[] }} */ (response);
  if (!mediaCookiesEnabled(env)) return result;
  try {
    const cookies = await mintMediaCookies(siteId, options);
    if (cookies.length)
      result.cookies = [...(result.cookies ?? []), ...cookies];
  } catch (error) {
    console.error(
      JSON.stringify({
        marker: "MediaCookieMintFailed",
        siteId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return result;
}
