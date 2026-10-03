import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { redeemEnrollmentGrant } = await import("./enrollment.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("DEVICE_TOKEN_SECRET", "test-device-secret-at-least-32-bytes");
});

describe("Manager enrollment redemption", () => {
  it("atomically consumes one grant and creates physical, binding, and compatibility records", async () => {
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
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const response = await call(
      event({
        grantId: "grant-1",
        token,
        physicalDeviceId: "physical_device_1",
        label: "Alex's tablet",
      }),
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
    expect(transaction.input.TransactItems).toHaveLength(7);
    const binding = transaction.input.TransactItems[4].Put.Item;
    expect(binding).toMatchObject({
      type: "deviceBinding",
      physicalDeviceId: "physical_device_1",
      siteId: "site-1",
      accessLevel: "manager",
      membershipGeneration: 2,
      siteCredentialGeneration: 4,
      inactivityLimitDays: 60,
    });
    const compatibility = transaction.input.TransactItems[5].Put.Item;
    expect(compatibility).toMatchObject({
      type: "device",
      accessLevel: "manager",
    });
    expect(JSON.stringify(transaction.input)).not.toContain(token);
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
});

/**
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
function event(body) {
  return { body: JSON.stringify(body), requestContext: {} };
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
