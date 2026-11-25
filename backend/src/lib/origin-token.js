// Shared Secrets Manager loader for the CloudFront origin-verification token.
// Local dev and unit tests supply the plaintext env var directly; deployed
// Lambdas receive only the secret ARN and fetch + cache SecretString at cold
// start, keeping the token out of Lambda environment variables.
//
// The cache lives as long as the Lambda instance. Rotation still reaches every
// instance because Terraform stamps the secret's version id into each consumer's
// environment (`*_ORIGIN_TOKEN_VERSION`): a new version changes the function
// configuration, so Lambda starts fresh instances that read the new token.

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** Module-scope cache keyed by secret ARN. @type {Map<string, string>} */
const tokenCache = new Map();

/** When each ARN's last read failed (ms). @type {Map<string, number>} */
const failedAt = new Map();

/** A slow read must not eat a caller's request budget. */
const READ_TIMEOUT_MS = 3000;
/** After a failure, fail fast instead of calling Secrets Manager on every request. */
const FAILURE_BACKOFF_MS = 60_000;

/**
 * Resolve an origin-verification token from either a local plaintext env var
 * or a deployed Secrets Manager ARN. Returns `""` when neither is configured.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ envKey: string, secretArnKey: string }} keys
 * @returns {Promise<string>}
 */
export async function getOriginToken(env, { envKey, secretArnKey }) {
  const direct = env[envKey];
  if (direct) return direct;

  const secretArn = env[secretArnKey];
  if (!secretArn) return "";

  const cached = tokenCache.get(secretArn);
  if (cached) return cached;

  const lastFailure = failedAt.get(secretArn);
  if (
    lastFailure !== undefined &&
    Date.now() - lastFailure < FAILURE_BACKOFF_MS
  ) {
    throw new Error("Origin token unavailable (recent read failed)");
  }

  try {
    secretsClient ??= new SecretsManagerClient({});
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
      { abortSignal: globalThis.AbortSignal.timeout(READ_TIMEOUT_MS) },
    );
    const value = res.SecretString || "";
    if (!value) throw new Error("Origin token secret has no SecretString");
    tokenCache.set(secretArn, value);
    failedAt.delete(secretArn);
    return value;
  } catch (error) {
    failedAt.set(secretArn, Date.now());
    // One line per failed read (at most one a minute per instance). Callers
    // fail closed: support answers 503; the code-attempt limiter falls back to
    // API Gateway's source IP. No ARN or token in the log.
    console.warn(
      JSON.stringify({
        marker: "OriginTokenUnavailable",
        key: secretArnKey,
        reason: error instanceof Error ? error.name : "unknown",
      }),
    );
    throw error;
  }
}

/** Drop the cached origin tokens and failure back-off (for tests). */
export function resetOriginTokenCache() {
  tokenCache.clear();
  failedAt.clear();
}
