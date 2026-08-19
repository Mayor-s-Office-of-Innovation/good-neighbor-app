// Resolve GNP's per-consumer analyzer API key (the `x-api-key` header). This is
// a server-side credential — never sent to the device, never logged (see
// MVP-TODO 🔒 analyzer-auth). Step C reads it from the environment
// (`ANALYZER_API_KEY`), which covers local runs and the demo deployment.
// Production holds it in Secrets Manager (`ANALYZER_API_KEY_SECRET_ARN`); this
// module fetches it once and caches it at module scope (a warm Lambda reuses the
// value across invocations). All paths go through this one seam.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { getConfig } from "../config.js";

/** @type {SecretsManagerClient | undefined} */
let secretsClient;

/** Module-scope cache of the resolved key, keyed by secret ARN. @type {Map<string, string>} */
const cache = new Map();

/**
 * @param {import("../config.js").AppConfig} [config]
 * @returns {Promise<string>}
 */
export async function getAnalyzerApiKey(config = getConfig()) {
  if (config.analyzerApiKey) return config.analyzerApiKey;

  const secretArn = config.analyzerApiKeySecretArn;
  if (secretArn) {
    const cached = cache.get(secretArn);
    if (cached) return cached;

    secretsClient ??= new SecretsManagerClient({});
    const res = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    // The secret holds the raw key string (set out-of-band via
    // `aws secretsmanager put-secret-value`); it is never written by Terraform.
    const value = res.SecretString;
    if (!value) {
      throw new Error(
        `Analyzer API key secret ${secretArn} has no SecretString value`,
      );
    }
    cache.set(secretArn, value);
    return value;
  }

  throw new Error(
    "No analyzer API key configured: set ANALYZER_API_KEY (local) or ANALYZER_API_KEY_SECRET_ARN (prod)",
  );
}

/**
 * Drop the cached key so a subsequent call re-fetches (e.g. after the analyzer
 * rejects the current key with 401 and the secret has been rotated).
 * @param {string} [secretArn] clears just this ARN, or the whole cache if omitted
 */
export function resetAnalyzerApiKeyCache(secretArn) {
  if (secretArn) cache.delete(secretArn);
  else cache.clear();
}
