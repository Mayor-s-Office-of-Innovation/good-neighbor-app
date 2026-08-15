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
        BEDROCK_MODEL_ID: "model",
        S3_UPLOAD_BUCKET: "bucket",
        SQS_QUEUE_URL: "queue",
        DYNAMO_TABLE: "table",
      }),
    ).toEqual({
      bedrockModelId: "model",
      uploadBucket: "bucket",
      queueUrl: "queue",
      dynamoTable: "table",
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
