import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
const { secretSend } = vi.hoisted(() => ({ secretSend: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class GetSecretValueCommand {
    /** @param {Record<string, unknown>} input */
    constructor(input) {
      this.input = input;
    }
  },
  SecretsManagerClient: class SecretsManagerClient {
    /**
     * @param {Record<string, unknown>} command
     * @returns {unknown}
     */
    send(command) {
      return secretSend(command);
    }
  },
}));

const {
  consumeSetupCodeTransactItem,
  emailHash,
  issueSetupCode,
  resetSetupCodeSecretCache,
  setupCodePk,
  validateSetupCode,
  verifierSecret,
} = await import("./setup-codes.js");

beforeEach(() => {
  send.mockReset();
  secretSend.mockReset();
  resetSetupCodeSecretCache();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
});

afterEach(() => {
  resetSetupCodeSecretCache();
  vi.unstubAllEnvs();
});

describe("validateSetupCode", () => {
  it("accepts a pending dynamic setup code", async () => {
    send.mockResolvedValueOnce({
      Item: {
        pk: await setupCodePk("ABC123"),
        sk: "#META",
        type: "setupCode",
        status: "pending",
        expiresAt: "2999-01-01T00:00:00.000Z",
        maxUses: 3,
        uses: 2,
        siteId: "site-1",
        siteName: "City Hall",
        providerSiteId: "provider-site-1",
      },
    }).mockResolvedValueOnce({ Item: { status: "active" } });

    const valid = await validateSetupCode("abc-123");

    expect(valid?.kind).toBe("setupCode");
    expect(valid?.siteId).toBe("site-1");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: { pk: await setupCodePk("ABC123"), sk: "#META" },
        }),
      }),
    );
  });

  it("rejects exhausted dynamic setup codes without revealing why", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          type: "setupCode",
          status: "pending",
          expiresAt: "2999-01-01T00:00:00.000Z",
          maxUses: 3,
          uses: 3,
          siteId: "site-1",
          siteName: "City Hall",
        },
      })
      .mockResolvedValueOnce({});

    await expect(validateSetupCode("ABC123")).resolves.toBeNull();
  });

  it("rejects setup codes for inactive sites", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          type: "setupCode",
          status: "pending",
          expiresAt: "2999-01-01T00:00:00.000Z",
          maxUses: 3,
          uses: 0,
          siteId: "site-1",
          siteName: "City Hall",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "inactive" } });

    await expect(validateSetupCode("ABC123")).resolves.toBeNull();
  });
});

describe("consumeSetupCodeTransactItem", () => {
  it("builds a conditional consume update for dynamic codes", async () => {
    const valid = await validateSetupCode("ABC123", {
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(valid).toBeNull();

    const item = consumeSetupCodeTransactItem(
      {
        kind: "setupCode",
        code: "ABC123",
        siteId: "site-1",
        siteName: "City Hall",
        providerSiteId: undefined,
        item: {
          pk: "SETUP_CODE#abc",
          sk: "#META",
          type: "setupCode",
          codeId: "code-1",
          codeVerifier: "abc",
          status: "pending",
          expiresAt: "2999-01-01T00:00:00.000Z",
          maxUses: 3,
          uses: 2,
          siteId: "site-1",
          siteName: "City Hall",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      "2026-01-01T00:00:00.000Z",
    );

    expect(item?.Update?.ConditionExpression).toContain("uses < maxUses");
  });
});

describe("issueSetupCode", () => {
  it("writes a six-character code before revoking prior pending codes", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SETUP_CODE#old",
            sk: "#META",
            status: "pending",
            gsi6pk: `SETUP_CODE_PENDING#site-1#${await emailHash("Lead@Example.org")}`,
            gsi6sk: "2026-01-01T00:00:00.000Z",
            gsi7pk: "SETUP_CODE_PENDING_SITE#site-1",
            gsi7sk: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const { code, item } = await issueSetupCode({
      siteId: "site-1",
      siteName: "City Hall",
      providerSiteId: "provider-site-1",
      issuedTo: "Lead@Example.org",
      issuedBy: "test",
      now: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    expect(item.maxUses).toBe(3);
    expect(item.issuedTo).toBe("lead@example.org");

    const query = /** @type {QueryCommand} */ (send.mock.calls[0][0]);
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input.IndexName).toBe("GSI6");

    const put = /** @type {PutCommand} */ (send.mock.calls[1][0]);
    expect(put.input.Item?.pk).toMatch(/^SETUP_CODE#/);
    expect(put.input.ConditionExpression).toBe("attribute_not_exists(pk)");

    const revoke = /** @type {PutCommand} */ (send.mock.calls[2][0]);
    expect(revoke.input.Item?.status).toBe("revoked");
    expect(revoke.input.Item?.gsi7pk).toBeUndefined();
  });

  it("retries code collisions before revoking the previous pending code", async () => {
    const collision = new Error("collision");
    collision.name = "ConditionalCheckFailedException";
    send
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SETUP_CODE#old",
            sk: "#META",
            status: "pending",
          },
        ],
      })
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const { code } = await issueSetupCode({
      siteId: "site-1",
      siteName: "City Hall",
      providerSiteId: "provider-site-1",
      issuedTo: "lead@example.org",
      issuedBy: "test",
      now: new Date("2026-01-02T00:00:00.000Z"),
      generateCode: vi
        .fn()
        .mockReturnValueOnce("AAAAAA")
        .mockReturnValueOnce("BBBBBB"),
    });

    expect(code).toBe("BBBBBB");
    const firstPut = /** @type {PutCommand} */ (send.mock.calls[1][0]);
    const secondPut = /** @type {PutCommand} */ (send.mock.calls[2][0]);
    const revoke = /** @type {PutCommand} */ (send.mock.calls[3][0]);
    expect(firstPut.input.Item?.codeVerifier).not.toBe(
      secondPut.input.Item?.codeVerifier,
    );
    expect(revoke.input.Item?.pk).toBe("SETUP_CODE#old");
    expect(revoke.input.Item?.status).toBe("revoked");
  });
});

describe("verifierSecret", () => {
  it("loads and caches the deployed Secrets Manager value", async () => {
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "");
    vi.stubEnv("DEVICE_TOKEN_SECRET", "");
    vi.stubEnv(
      "DEVICE_TOKEN_SECRET_SECRET_ARN",
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:setup-code",
    );
    secretSend.mockResolvedValueOnce({ SecretString: "deployed-secret" });

    await expect(verifierSecret()).resolves.toBe("deployed-secret");
    await expect(verifierSecret()).resolves.toBe("deployed-secret");

    expect(secretSend).toHaveBeenCalledTimes(1);
    expect(secretSend.mock.calls[0][0].input.SecretId).toContain(
      "setup-code",
    );
  });

  it("fails closed when no verifier secret is configured", async () => {
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "");
    vi.stubEnv("DEVICE_TOKEN_SECRET", "");
    vi.stubEnv("DEVICE_TOKEN_SECRET_SECRET_ARN", "");

    await expect(verifierSecret()).rejects.toThrow(
      "No setup-code verifier secret configured",
    );
  });
});
