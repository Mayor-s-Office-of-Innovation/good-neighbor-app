// Shared Secrets Manager loader for the CloudFront origin-verification token.
// Local dev and unit tests supply the plaintext env var directly; deployed
// Lambdas receive only the secret ARN and fetch + cache SecretString at cold
// start, keeping the token out of Lambda environment variables.

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** Module-scope cache keyed by secret ARN. @type {Map<string, string>} */
const tokenCache = new Map();

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

  secretsClient ??= new SecretsManagerClient({});
  const res = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const value = res.SecretString || "";
  if (!value) {
    throw new Error(`Origin token secret ${secretArn} has no SecretString`);
  }
  tokenCache.set(secretArn, value);
  return value;
}

/** Drop the cached origin tokens (for tests or rotation). */
export function resetOriginTokenCache() {
  tokenCache.clear();
}
