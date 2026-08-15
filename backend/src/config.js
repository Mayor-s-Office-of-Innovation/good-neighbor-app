/**
 * @typedef {object} AppConfig
 * @property {string} bedrockModelId
 * @property {string} uploadBucket
 * @property {string} queueUrl
 * @property {string} dynamoTable
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AppConfig}
 */
export function getConfig(env = process.env) {
  const required = {
    bedrockModelId: env.BEDROCK_MODEL_ID,
    uploadBucket: env.S3_UPLOAD_BUCKET,
    queueUrl: env.SQS_QUEUE_URL,
    dynamoTable: env.DYNAMO_TABLE,
  };

  for (const [name, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`Missing required environment variable for ${name}`);
    }
  }

  return /** @type {AppConfig} */ (required);
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
