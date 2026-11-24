import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    /** @param {Record<string, unknown>} input */
    constructor(input) {
      this.input = input;
    }
  },
}));

const { getOriginToken, resetOriginTokenCache } = await import(
  "./origin-token.js"
);

beforeEach(() => {
  send.mockReset();
  resetOriginTokenCache();
});

describe("getOriginToken", () => {
  it("returns the local plaintext env var without calling Secrets Manager", async () => {
    const token = await getOriginToken(
      { SUPPORT_ORIGIN_TOKEN: "local-dev-token" },
      {
        envKey: "SUPPORT_ORIGIN_TOKEN",
        secretArnKey: "SUPPORT_ORIGIN_TOKEN_SECRET_ARN",
      },
    );
    expect(token).toBe("local-dev-token");
    expect(send).not.toHaveBeenCalled();
  });

  it("fetches and caches the secret from Secrets Manager by ARN", async () => {
    send.mockResolvedValueOnce({ SecretString: "deployed-secret-value" });
    const env = {
      SUPPORT_ORIGIN_TOKEN_SECRET_ARN:
        "arn:aws:secretsmanager:us-west-2:aws:secret:support-origin",
    };
    const keys = {
      envKey: "SUPPORT_ORIGIN_TOKEN",
      secretArnKey: "SUPPORT_ORIGIN_TOKEN_SECRET_ARN",
    };

    expect(await getOriginToken(env, keys)).toBe("deployed-secret-value");
    expect(await getOriginToken(env, keys)).toBe("deployed-secret-value");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
      SecretId: env.SUPPORT_ORIGIN_TOKEN_SECRET_ARN,
    });
  });

  it("returns empty string when neither env var is configured", async () => {
    const token = await getOriginToken(
      {},
      {
        envKey: "SUPPORT_ORIGIN_TOKEN",
        secretArnKey: "SUPPORT_ORIGIN_TOKEN_SECRET_ARN",
      },
    );
    expect(token).toBe("");
    expect(send).not.toHaveBeenCalled();
  });

  it("throws when Secrets Manager returns an empty SecretString", async () => {
    send.mockResolvedValueOnce({ SecretString: "" });
    await expect(
      getOriginToken(
        {
          SUPPORT_ORIGIN_TOKEN_SECRET_ARN:
            "arn:aws:secretsmanager:us-west-2:aws:secret:empty",
        },
        {
          envKey: "SUPPORT_ORIGIN_TOKEN",
          secretArnKey: "SUPPORT_ORIGIN_TOKEN_SECRET_ARN",
        },
      ),
    ).rejects.toThrow(/has no SecretString/);
  });
});
