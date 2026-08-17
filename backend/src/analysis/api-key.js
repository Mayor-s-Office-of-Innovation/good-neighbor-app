// Resolve GNP's per-consumer analyzer API key (the `x-api-key` header). This is
// a server-side credential — never sent to the device, never logged (see
// MVP-TODO 🔒 analyzer-auth). Step C reads it from the environment
// (`ANALYZER_API_KEY`), which covers local runs and the demo deployment.
// Production holds it in Secrets Manager (`ANALYZER_API_KEY_SECRET_ARN`); that
// fetch + module-scope cache + 401-triggered refresh is wired in Step E. Both
// paths go through this one seam.

import { getConfig } from "../config.js";

/**
 * @param {import("../config.js").AppConfig} [config]
 * @returns {Promise<string>}
 */
export async function getAnalyzerApiKey(config = getConfig()) {
  if (config.analyzerApiKey) return config.analyzerApiKey;

  if (config.analyzerApiKeySecretArn) {
    // TODO(step E): fetch from Secrets Manager and cache at module scope.
    throw new Error(
      "Analyzer key via Secrets Manager is not wired yet (Step E); set ANALYZER_API_KEY for local runs",
    );
  }

  throw new Error(
    "No analyzer API key configured: set ANALYZER_API_KEY (local) or ANALYZER_API_KEY_SECRET_ARN (prod)",
  );
}
