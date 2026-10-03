import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  createManagerMembership,
  deactivateManagerMembership,
  listManagerMemberships,
} = await import("./admin-manager-memberships.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-verifier-secret");
});

describe("Site Manager memberships", () => {
  it("lists only active memberships", async () => {
    send.mockResolvedValueOnce({
      Items: [
        { membershipId: "active-1", status: "active" },
        { membershipId: "inactive-1", status: "inactive" },
      ],
    });
    const response = await call(
      listManagerMemberships,
      event(undefined, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).memberships).toEqual([
      { membershipId: "active-1", status: "active" },
    ]);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
  });

  it("creates one single-Site Manager membership with a uniqueness marker", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockResolvedValueOnce({});
    const response = await call(
      createManagerMembership,
      event(
        { name: "  Alex Rivera  ", email: " ALEX@example.org " },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(4);
    const membership = transaction.input.TransactItems[0].Put.Item;
    expect(membership).toMatchObject({
      siteId: "site-1",
      name: "Alex Rivera",
      email: "alex@example.org",
      role: "manager",
      status: "active",
      generation: 1,
    });
    expect(transaction.input.TransactItems[1].Put.Item.sk).toMatch(
      /^MANAGER_EMAIL#[a-f0-9]{64}$/,
    );
    expect(transaction.input.TransactItems[2].Put.Item).toMatchObject({
      type: "managerMembershipDirectory",
      membershipId: membership.membershipId,
      siteId: "site-1",
      status: "active",
    });
    expect(transaction.input.TransactItems[3].Put.Item).toMatchObject({
      eventType: "manager_membership_created",
      actor: "admin-1",
    });
  });

  it("rejects duplicate active email membership", async () => {
    const conflict = new Error("duplicate");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockRejectedValueOnce(conflict);
    const response = await call(
      createManagerMembership,
      event(
        { name: "Alex Rivera", email: "alex@example.org" },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "manager_membership_exists",
    });
  });

  it("deactivates membership, advances its generation, and removes email uniqueness", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "MANAGER_MEMBERSHIP#membership-1",
          membershipId: "membership-1",
          emailHash: "email-hash",
          status: "active",
        },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      deactivateManagerMembership,
      event(undefined, { siteId: "site-1", membershipId: "membership-1" }),
    );
    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(
      transaction.input.TransactItems[0].Update.UpdateExpression,
    ).toContain("generation = generation + :one");
    expect(transaction.input.TransactItems[1].Delete.Key).toEqual({
      pk: "SITE#site-1",
      sk: "MANAGER_EMAIL#email-hash",
    });
    expect(transaction.input.TransactItems[2].Delete.Key).toEqual({
      pk: "MANAGER_EMAIL#email-hash",
      sk: "SITE#site-1#MEMBERSHIP#membership-1",
    });
    expect(transaction.input.TransactItems[3].Put.Item.eventType).toBe(
      "manager_membership_deactivated",
    );
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
        jwt: {
          claims: {
            "cognito:groups": "central-admin",
            sub: "admin-1",
          },
        },
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
