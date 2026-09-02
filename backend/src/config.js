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
 * @property {string} [sf311CreateSrUrl]
 * @property {string} [sf311AgencyLookupUrl]
 * @property {string} [sf311BasicAuthSecretArn]
 * @property {string} [sf311BasicAuthUser]
 * @property {string} [sf311BasicAuthPass]
 * @property {string} [sf311DefaultResponsibleAgency]
 * @property {string} [sf311ClassifierServiceCodeMap]
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

  if (env.SF311_CREATESR_URL) config.sf311CreateSrUrl = env.SF311_CREATESR_URL;
  if (env.SF311_AGENCY_LOOKUP_URL) {
    config.sf311AgencyLookupUrl = env.SF311_AGENCY_LOOKUP_URL;
  }
  if (env.SF311_BASIC_AUTH_SECRET_ARN) {
    config.sf311BasicAuthSecretArn = env.SF311_BASIC_AUTH_SECRET_ARN;
  }
  if (env.SF311_BASIC_AUTH_USER) {
    config.sf311BasicAuthUser = env.SF311_BASIC_AUTH_USER;
  }
  if (env.SF311_BASIC_AUTH_PASS) {
    config.sf311BasicAuthPass = env.SF311_BASIC_AUTH_PASS;
  }
  if (env.SF311_DEFAULT_RESPONSIBLE_AGENCY) {
    config.sf311DefaultResponsibleAgency = env.SF311_DEFAULT_RESPONSIBLE_AGENCY;
  }
  if (env.SF311_CLASSIFIER_SERVICE_CODE_MAP) {
    config.sf311ClassifierServiceCodeMap =
      env.SF311_CLASSIFIER_SERVICE_CODE_MAP;
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
