import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  send,
  sendManagerSecurityNotification,
  sendProviderManagerSecurityNotification,
} = vi.hoisted(() => ({
  send: vi.fn(),
  sendManagerSecurityNotification: vi.fn(),
  sendProviderManagerSecurityNotification: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/email.js", () => ({
  sendManagerSecurityNotification,
  sendProviderManagerSecurityNotification,
}));

const { redeemEnrollmentGrant } = await import("./enrollment.js");

beforeEach(() => {
  send.mockReset();
  sendManagerSecurityNotification.mockReset().mockResolvedValue({
    provider: "ses",
    messageId: "security-message-1",
  });
  sendProviderManagerSecurityNotification.mockReset().mockResolvedValue({
    provider: "ses",
    messageId: "provider-security-message-1",
  });
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("DEVICE_TOKEN_SECRET", "test-device-secret-at-least-32-bytes");
  vi.stubEnv("SETUP_CODE_EMAIL_REPLY_TO", "support@example.org");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Manager enrollment redemption", () => {
  it("atomically enrolls a Provider Manager at every active Site", async () => {
    const token = "provider-wide-secret-token";
    const tokenHash = await sha256(token);
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `ENROLLMENT_TOKEN#${tokenHash}`,
          sk: "#META",
          grantId: "provider-grant-1",
          grantPk: "PROVIDER#provider-1",
          grantSk: "PROVIDER_MANAGER_GRANT#time#provider-grant-1",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "PROVIDER#provider-1",
          sk: "PROVIDER_MANAGER_GRANT#time#provider-grant-1",
          scope: "provider",
          grantId: "provider-grant-1",
          providerId: "provider-1",
          membershipId: "membership-1",
          membershipGeneration: 3,
          accessLevel: "manager",
          status: "pending",
          tokenHash,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "PROVIDER#provider-1",
          sk: "#META",
          providerId: "provider-1",
          name: "Provider One",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "PROVIDER#provider-1",
            sk: "PROVIDER_MANAGER#manager-1",
            membershipId: "membership-1",
            status: "active",
            generation: 3,
            name: "Alex Rivera",
            email: "alex@example.org",
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            siteId: "site-1",
            siteName: "Site One",
            status: "active",
            siteCredentialGeneration: 2,
          },
        ],
        LastEvaluatedKey: { pk: "PROVIDER#provider-1", sk: "SITE#site-1" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            siteId: "site-2",
            siteName: "Site Two",
            status: "active",
            siteCredentialGeneration: 4,
          },
          { siteId: "site-old", status: "inactive" },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const response = await call(
      event({ grantId: "provider-grant-1", token, label: "Alex's tablet" }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body).toMatchObject({
      siteCount: 2,
      provider: { providerId: "provider-1", name: "Provider One" },
    });
    expect(
      body.bindings.map((/** @type {any} */ binding) => binding.siteId),
    ).toEqual(["site-1", "site-2"]);
    expect(send.mock.calls[3][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[4][0]).toBeInstanceOf(QueryCommand);
    const transaction = send.mock.calls[6][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(16);
    const siteConditions = transaction.input.TransactItems.filter(
      (/** @type {any} */ item) =>
        item.ConditionCheck?.Key?.pk?.startsWith("SITE#"),
    );
    expect(siteConditions).toHaveLength(2);
    expect(siteConditions[0].ConditionCheck.ConditionExpression).toContain(
      "siteCredentialGeneration = :siteGeneration",
    );
    expect(
      siteConditions.map(
        (/** @type {any} */ item) =>
          item.ConditionCheck.ExpressionAttributeValues[":siteGeneration"],
      ),
    ).toEqual([2, 4]);
    expect(
      transaction.input.TransactItems.filter(
        (/** @type {any} */ item) =>
          item.Put?.Item?.authorityScope === "provider",
      ),
    ).toHaveLength(4);
    expect(sendProviderManagerSecurityNotification).toHaveBeenCalledWith({
      to: "alex@example.org",
      managerName: "Alex Rivera",
      providerName: "Provider One",
      siteCount: 2,
      deviceLabel: "Alex's tablet",
      clientDescription: "unknown browser on unknown device",
      enrolledAt: expect.any(String),
      revocationContact: "support@example.org",
    });
  });

  it("atomically consumes one grant and creates a fresh binding on an existing physical identity", async () => {
    const token = "one-time-secret-token";
    const tokenHash = await sha256(token);
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `ENROLLMENT_TOKEN#${tokenHash}`,
          sk: "#META",
          grantId: "grant-1",
          grantPk: "SITE#site-1",
          grantSk: "MANAGER_GRANT#time#grant-1",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_GRANT#time#grant-1",
          grantId: "grant-1",
          siteId: "site-1",
          membershipId: "membership-1",
          accessLevel: "manager",
          status: "pending",
          tokenHash,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          status: "active",
          siteCredentialGeneration: 4,
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_MEMBERSHIP#membership-1",
          status: "active",
          generation: 2,
          name: "Alex Rivera",
          email: "alex@example.org",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "PHYSICAL_DEVICE#physical_device_1",
          sk: "#META",
          physicalDeviceId: "physical_device_1",
          status: "active",
          label: "Previously suspended tablet",
          lastSuspendedBindingId: "suspended-binding-1",
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const response = await call(
      event(
        {
          grantId: "grant-1",
          token,
          physicalDeviceId: "physical_device_1",
          label: "Alex's tablet",
        },
        {
          "user-agent": "Mozilla/5.0 (iPhone) Version/18.0 Mobile Safari/604.1",
        },
      ),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body).toMatchObject({
      physicalDeviceId: "physical_device_1",
      accessLevel: "manager",
      expiresIn: 15 * 60,
      refreshExpiresIn: 30 * 24 * 60 * 60,
    });
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(new Date(body.absoluteExpiresAt).getTime()).toBeGreaterThan(
      Date.now() + 364 * 24 * 60 * 60 * 1000,
    );
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[5][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(9);
    expect(transaction.input.TransactItems[2].Delete.Key).toEqual({
      pk: "SITE#site-1",
      sk: "MANAGER_GRANT_CURRENT#membership-1",
    });
    expect(transaction.input.TransactItems[4].Update.Key).toEqual({
      pk: "PHYSICAL_DEVICE#physical_device_1",
      sk: "#META",
    });
    const binding = transaction.input.TransactItems[5].Put.Item;
    expect(binding).toMatchObject({
      type: "deviceBinding",
      physicalDeviceId: "physical_device_1",
      siteId: "site-1",
      accessLevel: "manager",
      membershipGeneration: 2,
      siteCredentialGeneration: 4,
      inactivityLimitDays: 60,
    });
    expect(binding.bindingId).not.toBe("suspended-binding-1");
    const compatibility = transaction.input.TransactItems[6].Put.Item;
    expect(compatibility).toMatchObject({
      type: "device",
      accessLevel: "manager",
    });
    expect(transaction.input.TransactItems[7].Put.Item).toMatchObject({
      type: "physicalDeviceBindingPointer",
      physicalDeviceId: "physical_device_1",
      bindingId: binding.bindingId,
      siteId: "site-1",
      status: "active",
    });
    expect(JSON.stringify(transaction.input)).not.toContain(token);
    expect(sendManagerSecurityNotification).toHaveBeenCalledWith({
      to: "alex@example.org",
      managerName: "Alex Rivera",
      siteName: "Site One",
      deviceLabel: "Alex's tablet",
      clientDescription: "Safari on iOS/iPadOS",
      enrolledAt: expect.any(String),
      revocationContact: "support@example.org",
    });
    expect(send.mock.calls[6][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[6][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":status": "accepted",
        ":provider": "ses",
        ":messageId": "security-message-1",
        ":redeemed": "redeemed",
      },
    );
  });

  it("returns the same public failure for an unknown token", async () => {
    send.mockResolvedValueOnce({});
    const response = await call(
      event({ grantId: "unknown", token: "unknown-token" }),
    );
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "invalid_enrollment_grant",
    });
  });

  it("keeps a successful Manager enrollment valid when notification delivery fails", async () => {
    const token = "notification-failure-token";
    const tokenHash = await sha256(token);
    sendManagerSecurityNotification.mockRejectedValueOnce(
      new Error("SES unavailable"),
    );
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `ENROLLMENT_TOKEN#${tokenHash}`,
          sk: "#META",
          grantId: "grant-2",
          grantPk: "SITE#site-1",
          grantSk: "MANAGER_GRANT#time#grant-2",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_GRANT#time#grant-2",
          grantId: "grant-2",
          siteId: "site-1",
          membershipId: "membership-1",
          accessLevel: "manager",
          status: "pending",
          tokenHash,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", name: "Site One", status: "active" },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_MEMBERSHIP#membership-1",
          status: "active",
          generation: 1,
          name: "Alex Rivera",
          email: "alex@example.org",
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const response = await call(event({ grantId: "grant-2", token }));

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(response.body))).toMatchObject({
      accessLevel: "manager",
      site: { siteId: "site-1" },
    });
    expect(send.mock.calls[6][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":status": "failed",
        ":redeemed": "redeemed",
      },
    );
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        marker: "ManagerSecurityNotification",
        status: "failed",
        provider: "ses",
        siteId: "site-1",
      }),
    );
  });

  it("fails closed when a concurrent redemption wins", async () => {
    const token = "one-time-secret-token";
    const tokenHash = await sha256(token);
    const conflict = new Error("already redeemed");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `ENROLLMENT_TOKEN#${tokenHash}`,
          sk: "#META",
          grantId: "grant-1",
          grantPk: "SITE#site-1",
          grantSk: "MANAGER_GRANT#time#grant-1",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_GRANT#time#grant-1",
          grantId: "grant-1",
          siteId: "site-1",
          membershipId: "membership-1",
          accessLevel: "manager",
          status: "pending",
          tokenHash,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({ Item: { siteId: "site-1", name: "Site One" } })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_MEMBERSHIP#membership-1",
          status: "active",
          generation: 1,
        },
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conflict);
    const response = await call(event({ grantId: "grant-1", token }));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "invalid_enrollment_grant",
    });
  });

  it("redeems a staff grant only while its Manager binding and membership remain active", async () => {
    const token = "staff-one-time-secret";
    const tokenHash = await sha256(token);
    send
      .mockResolvedValueOnce({
        Item: {
          pk: `ENROLLMENT_TOKEN#${tokenHash}`,
          sk: "#META",
          grantId: "staff-grant-1",
          grantPk: "SITE#site-1",
          grantSk: "STAFF_GRANT#time#staff-grant-1",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "STAFF_GRANT#time#staff-grant-1",
          grantId: "staff-grant-1",
          siteId: "site-1",
          accessLevel: "general",
          label: "Night team tablet",
          issuedByBindingId: "manager-1",
          issuerMembershipId: "membership-1",
          issuerMembershipGeneration: 2,
          status: "pending",
          tokenHash,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          status: "active",
          siteCredentialGeneration: 4,
        },
      })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "DEVICE_BINDING#manager-1",
          status: "active",
          accessLevel: "manager",
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_MEMBERSHIP#membership-1",
          status: "active",
          generation: 2,
        },
      })
      .mockResolvedValueOnce({});

    const response = await call(
      event({
        grantId: "staff-grant-1",
        token,
        physicalDeviceId: "physical_device_2",
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(response.body))).toMatchObject({
      physicalDeviceId: "physical_device_2",
      accessLevel: "general",
    });
    const transaction = send.mock.calls[6][0];
    expect(transaction.input.TransactItems).toHaveLength(10);
    expect(transaction.input.TransactItems[5].Put.Item).toMatchObject({
      accessLevel: "general",
      label: "Night team tablet",
    });
    expect(transaction.input.TransactItems[9].Delete.Key).toEqual({
      pk: "SITE#site-1",
      sk: "ACTIVE_STAFF_GRANT#manager-1",
    });
  });
});

/**
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} [headers]
 * @returns {Record<string, unknown>}
 */
function event(body, headers = {}) {
  return { body: JSON.stringify(body), requestContext: {}, headers };
}

/**
 * @param {any} request
 * @returns {Promise<import("aws-lambda").APIGatewayProxyStructuredResultV2>}
 */
async function call(request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await redeemEnrollmentGrant(request, /** @type {any} */ ({}), () => {})
  );
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
async function sha256(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}
