import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Secrets Manager client so the secret-ARN path resolves without a real
// AWS call. `send` returns whatever the current test queues up.
const send = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    /** @param {any} input */
    constructor(input) {
      this.input = input;
    }
  },
}));

const { getAnalyzerApiKey, resetAnalyzerApiKeyCache } = await import(
  "./api-key.js"
);

const infra = { uploadBucket: "b", queueUrl: "q", dynamoTable: "t" };

describe("getAnalyzerApiKey", () => {
  beforeEach(() => {
    send.mockReset();
    resetAnalyzerApiKeyCache();
  });

  it("returns the env-provided key (local / demo path)", async () => {
    await expect(
      getAnalyzerApiKey({ ...infra, analyzerApiKey: "secret-key" }),
    ).resolves.toBe("secret-key");
    expect(send).not.toHaveBeenCalled();
  });

  it("fetches from Secrets Manager when only the ARN is set", async () => {
    send.mockResolvedValueOnce({ SecretString: "from-secrets-manager" });
    await expect(
      getAnalyzerApiKey({ ...infra, analyzerApiKeySecretArn: "arn:secret:a" }),
    ).resolves.toBe("from-secrets-manager");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("caches the resolved key across calls (warm Lambda reuse)", async () => {
    send.mockResolvedValueOnce({ SecretString: "cached-key" });
    const config = { ...infra, analyzerApiKeySecretArn: "arn:secret:b" };
    await expect(getAnalyzerApiKey(config)).resolves.toBe("cached-key");
    await expect(getAnalyzerApiKey(config)).resolves.toBe("cached-key");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("throws when the secret has no string value", async () => {
    send.mockResolvedValueOnce({ SecretString: undefined });
    await expect(
      getAnalyzerApiKey({ ...infra, analyzerApiKeySecretArn: "arn:secret:c" }),
    ).rejects.toThrow(/no SecretString/);
  });

  it("rejects when no key source is configured", async () => {
    await expect(getAnalyzerApiKey({ ...infra })).rejects.toThrow(
      /No analyzer API key/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
