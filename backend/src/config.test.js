import { describe, expect, it } from "vitest";
import {
  getComplianceLetterBucket,
  getConfig,
  getDynamoTableName,
} from "./config.js";

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

  it("uses a dedicated compliance-letter bucket when configured", () => {
    expect(
      getConfig({
        S3_UPLOAD_BUCKET: "uploads",
        S3_COMPLIANCE_LETTER_BUCKET: "letters",
        SQS_QUEUE_URL: "queue",
        DYNAMO_TABLE: "table",
      }),
    ).toMatchObject({
      uploadBucket: "uploads",
      complianceLetterBucket: "letters",
    });
  });

  it("requires dedicated storage when a compliance-letter operation runs", () => {
    expect(() => getComplianceLetterBucket({})).toThrow(
      "Missing required environment variable for complianceLetterBucket",
    );
    expect(
      getComplianceLetterBucket({
        S3_COMPLIANCE_LETTER_BUCKET: "letters",
      }),
    ).toBe("letters");
  });

  it("enables reverse geocoding only when explicitly configured", () => {
    const base = {
      S3_UPLOAD_BUCKET: "bucket",
      SQS_QUEUE_URL: "queue",
      DYNAMO_TABLE: "table",
    };
    expect(getConfig(base)).not.toHaveProperty("reverseGeocodingEnabled");
    expect(
      getConfig({ ...base, REVERSE_GEOCODING_ENABLED: "false" }),
    ).not.toHaveProperty("reverseGeocodingEnabled");
    expect(
      getConfig({ ...base, REVERSE_GEOCODING_ENABLED: "true" }),
    ).toMatchObject({
      reverseGeocodingEnabled: true,
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
