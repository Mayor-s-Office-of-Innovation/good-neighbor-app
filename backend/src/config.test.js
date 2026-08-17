import { describe, expect, it } from "vitest";
import { getConfig, getDynamoTableName } from "./config.js";

describe("getConfig", () => {
  it("requires deployment configuration", () => {
    expect(() => getConfig({})).toThrow(
      "Missing required environment variable",
    );
  });

  it("returns typed configuration", () => {
    expect(
      getConfig({
        S3_UPLOAD_BUCKET: "bucket",
        SQS_QUEUE_URL: "queue",
        DYNAMO_TABLE: "table",
      }),
    ).toEqual({
      uploadBucket: "bucket",
      queueUrl: "queue",
      dynamoTable: "table",
    });
  });

  it("passes analyzer wiring through when present, and omits it otherwise", () => {
    const base = {
      S3_UPLOAD_BUCKET: "bucket",
      SQS_QUEUE_URL: "queue",
      DYNAMO_TABLE: "table",
    };

    expect(getConfig(base)).not.toHaveProperty("analyzerBaseUrl");

    expect(
      getConfig({
        ...base,
        ANALYZER_BASE_URL: "https://analyzer.example.org/",
        ANALYZER_API_KEY: "secret-key",
        ANALYZER_API_KEY_SECRET_ARN: "arn:aws:secretsmanager:…:key",
      }),
    ).toMatchObject({
      analyzerBaseUrl: "https://analyzer.example.org/",
      analyzerApiKey: "secret-key",
      analyzerApiKeySecretArn: "arn:aws:secretsmanager:…:key",
    });
  });
});

describe("getDynamoTableName", () => {
  it("requires the table name", () => {
    expect(() => getDynamoTableName({})).toThrow(
      "Missing required environment variable",
    );
  });

  it("returns the table name without requiring unrelated service config", () => {
    expect(getDynamoTableName({ DYNAMO_TABLE: "gnp-test-app" })).toBe(
      "gnp-test-app",
    );
  });
});
