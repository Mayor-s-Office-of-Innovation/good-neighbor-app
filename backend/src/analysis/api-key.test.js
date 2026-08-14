import { describe, expect, it } from "vitest";
import { getAnalyzerApiKey } from "./api-key.js";

const infra = { uploadBucket: "b", queueUrl: "q", dynamoTable: "t" };

describe("getAnalyzerApiKey", () => {
  it("returns the env-provided key (local / demo path)", async () => {
    await expect(
      getAnalyzerApiKey({ ...infra, analyzerApiKey: "secret-key" }),
    ).resolves.toBe("secret-key");
  });

  it("rejects until Secrets Manager resolution is wired (Step E)", async () => {
    await expect(
      getAnalyzerApiKey({ ...infra, analyzerApiKeySecretArn: "arn:…" }),
    ).rejects.toThrow(/Secrets Manager/);
  });

  it("rejects when no key source is configured", async () => {
    await expect(getAnalyzerApiKey({ ...infra })).rejects.toThrow(
      /No analyzer API key/,
    );
  });
});
