import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
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
    const pk = await setupCodePk("ABC123");
    send
      .mockResolvedValueOnce({
        Item: {
          pk,
          sk: "#META",
          type: "setupCode",
          status: "pending",
          expiresAt: "2999-01-01T00:00:00.000Z",
          maxUses: 3,
          uses: 2,
          siteId: "site-1",
          siteName: "City Hall",
          providerSiteId: "provider-site-1",
          issuedTo: "lead@example.org",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({ Item: { currentCodePk: pk } });

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

  it("rejects dynamic setup codes that are no longer current", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          pk: "SETUP_CODE#old",
          sk: "#META",
          type: "setupCode",
          status: "pending",
          expiresAt: "2999-01-01T00:00:00.000Z",
          maxUses: 3,
          uses: 0,
          siteId: "site-1",
          siteName: "City Hall",
          issuedTo: "lead@example.org",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({ Item: { currentCodePk: "SETUP_CODE#new" } });

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
  it("writes a six-character code and advances the current-code pointer", async () => {
    send
      .mockResolvedValueOnce({
        Item: undefined,
      })
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

    const currentRead = /** @type {GetCommand} */ (send.mock.calls[0][0]);
    expect(currentRead).toBeInstanceOf(GetCommand);
    expect(currentRead.input.ConsistentRead).toBe(true);
    expect(currentRead.input.Key?.pk).toMatch(/^SETUP_CODE_CURRENT#site-1#/);

    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    expect(tx.input.TransactItems?.[0]).toMatchObject({
      Put: {
        Item: {
          pk: expect.stringMatching(/^SETUP_CODE#/),
          status: "pending",
          gsi6pk: `SETUP_CODE_PENDING#site-1#${await emailHash("Lead@Example.org")}`,
          gsi7pk: "SETUP_CODE_PENDING_SITE#site-1",
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
    expect(tx.input.TransactItems?.[1]).toMatchObject({
      Put: {
        Item: {
          pk: expect.stringMatching(/^SETUP_CODE_CURRENT#site-1#/),
          currentCodePk: item.pk,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  });

  it("transactionally revokes the previous current code", async () => {
    const contactHash = await emailHash("lead@example.org");
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `SETUP_CODE_CURRENT#site-1#${contactHash}`,
          sk: "#META",
          currentCodePk: "SETUP_CODE#old",
        },
      })
      .mockResolvedValueOnce({});

    await issueSetupCode({
      siteId: "site-1",
      siteName: "City Hall",
      providerSiteId: "provider-site-1",
      issuedTo: "lead@example.org",
      issuedBy: "test",
      now: new Date("2026-01-02T00:00:00.000Z"),
      generateCode: vi.fn().mockReturnValue("BBBBBB"),
    });

    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx.input.TransactItems?.[1]).toMatchObject({
      Update: {
        Key: { pk: "SETUP_CODE#old", sk: "#META" },
        UpdateExpression: expect.stringContaining("REMOVE gsi6pk"),
      },
    });
    expect(tx.input.TransactItems?.[2]).toMatchObject({
      Put: {
        ConditionExpression: "currentCodePk = :expectedCodePk",
        ExpressionAttributeValues: {
          ":expectedCodePk": "SETUP_CODE#old",
        },
      },
    });
  });

  it("uses the current-code pointer even when the pending-code GSI would be stale", async () => {
    const contactHash = await emailHash("lead@example.org");
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `SETUP_CODE_CURRENT#site-1#${contactHash}`,
          sk: "#META",
          currentCodePk: "SETUP_CODE#recent",
        },
      })
      .mockResolvedValueOnce({});

    await issueSetupCode({
      siteId: "site-1",
      siteName: "City Hall",
      providerSiteId: "provider-site-1",
      issuedTo: "lead@example.org",
      issuedBy: "test",
      now: new Date("2026-01-02T00:00:00.000Z"),
      generateCode: vi.fn().mockReturnValue("CCCCCC"),
    });

    expect(
      send.mock.calls.some(([cmd]) => cmd instanceof QueryCommand),
    ).toBe(false);
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx.input.TransactItems?.[1]).toMatchObject({
      Update: {
        Key: { pk: "SETUP_CODE#recent", sk: "#META" },
      },
    });
  });

  it("retries code collisions and pointer contention", async () => {
    const collision = new Error("collision");
    collision.name = "ConditionalCheckFailedException";
    send
      .mockResolvedValueOnce({
        Item: undefined,
      })
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({
        Item: {
          pk: `SETUP_CODE_CURRENT#site-1#${await emailHash("lead@example.org")}`,
          sk: "#META",
          currentCodePk: "SETUP_CODE#winner",
        },
      })
      .mockResolvedValueOnce({})

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
    expect(send.mock.calls[1][0]).toBeInstanceOf(TransactWriteCommand);
    expect(send.mock.calls[3][0]).toBeInstanceOf(TransactWriteCommand);
    const retryTx = /** @type {TransactWriteCommand} */ (send.mock.calls[3][0]);
    expect(retryTx.input.TransactItems?.[1]).toMatchObject({
      Update: {
        Key: { pk: "SETUP_CODE#winner", sk: "#META" },
      },
    });
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
