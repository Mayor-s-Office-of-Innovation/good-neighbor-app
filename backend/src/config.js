export type AppConfig = {
  bedrockModelId: string;
  uploadBucket: string;
  queueUrl: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = {
    bedrockModelId: env.BEDROCK_MODEL_ID,
    uploadBucket: env.S3_UPLOAD_BUCKET,
    queueUrl: env.SQS_QUEUE_URL,
  };

  for (const [name, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`Missing required environment variable for ${name}`);
    }
  }

  return required as AppConfig;
}
