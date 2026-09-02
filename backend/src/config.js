/**
 * @typedef {object} AppConfig
 * @property {string} uploadBucket
 * @property {string} queueUrl
 * @property {string} dynamoTable
 * @property {string} [analyzerBaseUrl]
 * @property {string} [analyzerApiKey]
 * @property {string} [analyzerApiKeySecretArn]
 * @property {string} [posthogProjectApiKey]
 * @property {string} [posthogApiKeySecretArn]
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AppConfig}
 */
export function getConfig(env = process.env) {
  const required = {
    uploadBucket: env.S3_UPLOAD_BUCKET,
    queueUrl: env.SQS_QUEUE_URL,
    dynamoTable: env.DYNAMO_TABLE,
  };

  for (const [name, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`Missing required environment variable for ${name}`);
    }
  }

  const config = /** @type {AppConfig} */ (required);

  // Analyzer wiring is optional at load time: the check/artifact API handlers
  // don't touch the analyzer, and leaving it optional lets the config load in
  // the local API and unit tests where no analyzer is configured. The analyze
  // worker validates its own needs (base URL + a key source) at invocation.
  if (env.ANALYZER_BASE_URL) config.analyzerBaseUrl = env.ANALYZER_BASE_URL;
  if (env.ANALYZER_API_KEY) config.analyzerApiKey = env.ANALYZER_API_KEY;
  if (env.ANALYZER_API_KEY_SECRET_ARN) {
    config.analyzerApiKeySecretArn = env.ANALYZER_API_KEY_SECRET_ARN;
  }

  // PostHog forwarder wiring is likewise optional at load time: unset/empty
  // means the client-error forwarder runs in log-only mode (validate + log,
  // no egress) — the governance-gate default. See handlers/posthog-api-key.js.
  if (env.POSTHOG_PROJECT_API_KEY) {
    config.posthogProjectApiKey = env.POSTHOG_PROJECT_API_KEY;
  }
  if (env.POSTHOG_API_KEY_SECRET_ARN) {
    config.posthogApiKeySecretArn = env.POSTHOG_API_KEY_SECRET_ARN;
  }

  return config;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function getDynamoTableName(env = process.env) {
  if (!env.DYNAMO_TABLE) {
    throw new Error("Missing required environment variable for dynamoTable");
  }
  return env.DYNAMO_TABLE;
}
