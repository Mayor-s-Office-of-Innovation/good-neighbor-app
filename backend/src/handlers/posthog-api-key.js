// Resolve the PostHog project API key for the client-error forwarder. The key
// is a write-only ingest key — safe to hold server-side, never sent to clients
// and never logged. Terraform creates the secret *container* only; the value is
// set out-of-band via `aws secretsmanager put-secret-value` (same pattern as
// `analysis/api-key.js`) so it never enters state or VCS.
//
// Missing-value semantics (per the error-tracking plan): a container with no
// value set makes GetSecretValue *throw* — that specific "empty container"
// case resolves to `null` (quiet log-only mode, no WARN spam) rather than
// erroring. Transient fetch/decryption failures propagate to the caller, which
// logs them as ClientErrorForwardFailed.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { getConfig } from "../config.js";

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** Module-scope cache, keyed by secret ARN. @type {Map<string, string>} */
const cache = new Map();

/*
 * Sentinel cached for the "container exists but has no value yet" case, so a
 * warm container doesn't re-fetch on every report.
 */
const EMPTY = "\u0000empty";

/**
 * @param {import("../config.js").AppConfig} [config]
 * @returns {Promise<string | undefined>} the ingest key, or undefined in
 *   log-only mode (no env key, no secret ARN, or empty container)
 */
export async function getPosthogApiKey(config = getConfig()) {
  if (config.posthogProjectApiKey) return config.posthogProjectApiKey;

  const secretArn = config.posthogApiKeySecretArn;
  if (!secretArn) return undefined;

  const cached = cache.get(secretArn);
  if (cached === EMPTY) return undefined;
  if (cached) return cached;

  try {
    secretsClient ??= new SecretsManagerClient({});
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    // The secret holds the raw project API key string (put out-of-band).
    const value = res.SecretString;
    if (!value) {
      cache.set(secretArn, EMPTY);
      return undefined;
    }
    cache.set(secretArn, value);
    return value;
  } catch (err) {
    // ResourceNotFound = the pre-sign-off empty-container case: quiet
    // log-only mode. Anything else (KMS, permissions, network) is a real
    // problem — surface it to the caller's WARN path.
    if (isResourceNotFound(/** @type {unknown} */ (err))) {
      cache.set(secretArn, EMPTY);
      return undefined;
    }
    throw err;
  }
}

/**
 * Drop the cached value so a subsequent call re-fetches (post-rotation /
 * post-`put-secret-value`, since containers cache for the Lambda's lifetime).
 * @param {string} [secretArn] clears just this ARN, or the whole cache if omitted
 */
export function resetPosthogApiKeyCache(secretArn) {
  if (secretArn) cache.delete(secretArn);
  else cache.clear();
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isResourceNotFound(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    /** @type {{name?: unknown}} */ (err).name === "ResourceNotFoundException"
  );
}
