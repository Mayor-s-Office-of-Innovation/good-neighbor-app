import { describe, expect, it } from "vitest";
import { getConfig } from "./config.js";

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
      }),
    ).toEqual({
      bedrockModelId: "model",
      uploadBucket: "bucket",
      queueUrl: "queue",
    });
  });
});
