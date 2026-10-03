import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, sendManagerEnrollmentEmail } = vi.hoisted(() => ({
  send: vi.fn(),
  sendManagerEnrollmentEmail: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/email.js", () => ({ sendManagerEnrollmentEmail }));

const { cancelManagerGrant, createManagerGrant, listManagerGrants } =
  await import("./admin-manager-grants.js");

beforeEach(() => {
  send.mockReset();
  sendManagerEnrollmentEmail.mockReset().mockResolvedValue({
    provider: "ses",
    messageId: "message-1",
  });
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("PROVIDER_APP_URL", "https://goodneighborsf.org/");
});

describe("City-issued Manager enrollment grants", () => {
  it("lists grants without returning token hashes", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          grantId: "grant-1",
          membershipId: "membership-1",
          siteId: "site-1",
          status: "pending",
          tokenHash: "secret-verifier",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ],
    });
    const response = await call(
      listManagerGrants,
      event(undefined, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(String(response.body)).not.toContain("secret-verifier");
  });

  it("creates a 15-minute single-Site grant and emails its one-time link", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", name: "Site One" } })
      .mockResolvedValueOnce({
        Item: {
          membershipId: "membership-1",
          status: "active",
          name: "Alex Rivera",
          email: "alex@example.org",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const response = await call(
      createManagerGrant,
      event({ membershipId: "membership-1" }, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(3);
    const grant = transaction.input.TransactItems[0].Put.Item;
    expect(grant).toMatchObject({
      siteId: "site-1",
      membershipId: "membership-1",
      accessLevel: "manager",
      status: "pending",
    });
    expect(
      new Date(grant.expiresAt).getTime() - new Date(grant.createdAt).getTime(),
    ).toBe(15 * 60 * 1000);
    expect(transaction.input.TransactItems[1].Put.Item.pk).toMatch(
      /^ENROLLMENT_TOKEN#[a-f0-9]{64}$/,
    );
    expect(sendManagerEnrollmentEmail).toHaveBeenCalledOnce();
    const email = sendManagerEnrollmentEmail.mock.calls[0][0];
    expect(email.enrollmentUrl).toContain("#enrollment_grant=");
    expect(email.enrollmentUrl).toContain("enrollment_token=");
    expect(send.mock.calls[4][0]).toBeInstanceOf(UpdateCommand);
  });

  it("records failed delivery without exposing a provider error", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", name: "Site One" } })
      .mockResolvedValueOnce({
        Item: {
          membershipId: "membership-1",
          status: "active",
          name: "Alex Rivera",
          email: "alex@example.org",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    sendManagerEnrollmentEmail.mockRejectedValueOnce(
      new Error("private SES error"),
    );
    const response = await call(
      createManagerGrant,
      event({ membershipId: "membership-1" }, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(response.body)).grant.deliveryStatus).toBe(
      "failed",
    );
    expect(String(response.body)).not.toContain("private SES error");
  });

  it("replaces the membership's prior unexpired pending grant", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", name: "Site One" } })
      .mockResolvedValueOnce({
        Item: {
          membershipId: "membership-1",
          status: "active",
          name: "Alex Rivera",
          email: "alex@example.org",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "MANAGER_GRANT#old#grant-old",
            grantId: "grant-old",
            membershipId: "membership-1",
            status: "pending",
            expiresAt: "2099-01-01T00:00:00.000Z",
            tokenHash: "old-token-hash",
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const response = await call(
      createManagerGrant,
      event({ membershipId: "membership-1" }, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(201);
    const transaction = send.mock.calls[3][0];
    expect(transaction.input.TransactItems).toHaveLength(5);
    expect(transaction.input.TransactItems[3].Update).toMatchObject({
      Key: { pk: "SITE#site-1", sk: "MANAGER_GRANT#old#grant-old" },
    });
    expect(transaction.input.TransactItems[4].Delete.Key).toEqual({
      pk: "ENROLLMENT_TOKEN#old-token-hash",
      sk: "#META",
    });
  });

  it("cancels a pending grant and removes its token lookup atomically", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "MANAGER_GRANT#time#grant-1",
            grantId: "grant-1",
            membershipId: "membership-1",
            status: "pending",
            tokenHash: "token-hash",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const response = await call(
      cancelManagerGrant,
      event(undefined, { siteId: "site-1", grantId: "grant-1" }),
    );
    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[1].Delete.Key).toEqual({
      pk: "ENROLLMENT_TOKEN#token-hash",
      sk: "#META",
    });
  });
});

/**
 * @param {unknown} body
 * @param {Record<string, string>} pathParameters
 * @returns {Record<string, unknown>}
 */
function event(body = undefined, pathParameters = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": "central-admin", sub: "admin-1" } },
      },
    },
  };
}

/**
 * @param {Function} handler
 * @param {any} request
 * @returns {Promise<import("aws-lambda").APIGatewayProxyStructuredResultV2>}
 */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, {}, () => {})
  );
}
