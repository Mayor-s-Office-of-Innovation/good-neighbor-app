/**
 * @typedef {object} AppConfig
 * @property {string} uploadBucket
 * @property {string} queueUrl
 * @property {string} dynamoTable
 * @property {string} [analyzerBaseUrl]
 * @property {string} [analyzerApiKey]
 * @property {string} [analyzerApiKeySecretArn]
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

  return config;
}
