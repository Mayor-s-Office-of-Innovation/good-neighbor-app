import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the Secrets Manager client so the secret-ARN path resolves without a
// real AWS call (same mock shape as analysis/api-key.test.js).
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

const { getPosthogApiKey, resetPosthogApiKeyCache } = await import(
  "./posthog-api-key.js"
);

const infra = { uploadBucket: "b", queueUrl: "q", dynamoTable: "t" };

describe("posthog api key resolution", () => {
  afterEach(() => {
    resetPosthogApiKeyCache();
    send.mockReset();
  });

  it("prefers the direct env/config key over Secrets Manager", async () => {
    await expect(
      getPosthogApiKey({ ...infra, posthogProjectApiKey: "phc_direct" }),
    ).resolves.toBe("phc_direct");
    expect(send).not.toHaveBeenCalled();
  });

  it("returns undefined in log-only mode when nothing is configured", async () => {
    await expect(getPosthogApiKey({ ...infra })).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("empty secret container (ResourceNotFound) → quiet log-only, cached", async () => {
    const config = { ...infra, posthogApiKeySecretArn: "arn:secret:empty" };
    const notFound = Object.assign(
      new Error("Secrets Manager cannot find the requested secret."),
      {
        name: "ResourceNotFoundException",
      },
    );
    send.mockRejectedValueOnce(notFound);

    await expect(getPosthogApiKey(config)).resolves.toBeUndefined();

    // Cached: the second call doesn't hit Secrets Manager again (no WARN spam
    // on a warm container between first apply and put-secret-value).
    await expect(getPosthogApiKey(config)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("empty SecretString value → quiet log-only, cached", async () => {
    const config = { ...infra, posthogApiKeySecretArn: "arn:secret:null" };
    send.mockResolvedValueOnce({ SecretString: undefined });

    await expect(getPosthogApiKey(config)).resolves.toBeUndefined();
    await expect(getPosthogApiKey(config)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("surfaces non-404 secret failures to the caller", async () => {
    const config = { ...infra, posthogApiKeySecretArn: "arn:secret:kms" };
    send.mockRejectedValueOnce(new Error("KMS decrypt denied"));

    await expect(getPosthogApiKey(config)).rejects.toThrow("KMS");
  });

  it("caches a present key at module scope", async () => {
    send.mockResolvedValueOnce({ SecretString: "phc_real" });
    const config = { ...infra, posthogApiKeySecretArn: "arn:secret:real" };

    await expect(getPosthogApiKey(config)).resolves.toBe("phc_real");
    await expect(getPosthogApiKey(config)).resolves.toBe("phc_real");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
