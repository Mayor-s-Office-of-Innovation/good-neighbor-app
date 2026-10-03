import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  cancelStaffGrant,
  createStaffGrant,
  getCurrentStaffGrant,
  listGeneralBindings,
  revokeGeneralBinding,
} = await import("./manager-access.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("PROVIDER_APP_URL", "https://field.example.test/");
});

describe("manager staff enrollment", () => {
  it("issues one ten-minute general grant without storing its secret", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", name: "Site One" } })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-1",
          sk: "DEVICE_BINDING#manager-1",
          status: "active",
          accessLevel: "manager",
          membershipId: "membership-1",
          membershipGeneration: 2,
          tokenGeneration: 4,
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      createStaffGrant,
      event({ body: { label: "Front desk tablet" } }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body.grant).toMatchObject({
      label: "Front desk tablet",
      accessLevel: "general",
      status: "pending",
    });
    expect(body.enrollmentUrl).toContain("#enrollment_grant=");
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(5);
    const serialized = JSON.stringify(transaction.input);
    expect(serialized).not.toContain(
      new URL(body.enrollmentUrl).hash.match(/enrollment_token=([^&]+)/)?.[1],
    );
  });

  it("rejects general devices from manager operations", async () => {
    const response = await call(
      createStaffGrant,
      event({ accessLevel: "general", body: { label: "Tablet" } }),
    );
    expect(response.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns and cancels only the current Manager binding's grant", async () => {
    const marker = {
      pk: "SITE#site-1",
      sk: "ACTIVE_STAFF_GRANT#manager-1",
      grantId: "staff-1",
      grantPk: "SITE#site-1",
      grantSk: "STAFF_GRANT#time#staff-1",
    };
    const grant = {
      pk: marker.grantPk,
      sk: marker.grantSk,
      grantId: "staff-1",
      label: "Team phone",
      issuedByBindingId: "manager-1",
      status: "pending",
      tokenHash: "token-hash",
      createdAt: "2026-10-03T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    send
      .mockResolvedValueOnce({ Item: marker })
      .mockResolvedValueOnce({ Item: grant });
    const current = await call(getCurrentStaffGrant, event());
    expect(current.statusCode).toBe(200);
    expect(JSON.parse(String(current.body)).grant).toMatchObject({
      grantId: "staff-1",
      label: "Team phone",
    });

    send
      .mockResolvedValueOnce({ Item: marker })
      .mockResolvedValueOnce({ Item: grant })
      .mockResolvedValueOnce({});
    const cancelled = await call(
      cancelStaffGrant,
      event({ pathParameters: { grantId: "staff-1" } }),
    );
    expect(cancelled.statusCode).toBe(200);
    const transaction = send.mock.calls[4][0];
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(transaction.input.TransactItems[1].Delete.Key).toEqual({
      pk: "ENROLLMENT_TOKEN#token-hash",
      sk: "#META",
    });
  });

  it("lists only general bindings", async () => {
    send.mockResolvedValueOnce({
      Items: [
        { bindingId: "general-1", accessLevel: "general", status: "active" },
        { bindingId: "manager-2", accessLevel: "manager", status: "active" },
      ],
    });
    const response = await call(listGeneralBindings, event());
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(JSON.parse(String(response.body)).bindings).toEqual([
      expect.objectContaining({
        bindingId: "general-1",
        accessLevel: "general",
      }),
    ]);
  });

  it("revokes a general binding, its compatibility row, and its pointer", async () => {
    const binding = {
      pk: "SITE#site-1",
      sk: "DEVICE_BINDING#general-1",
      bindingId: "general-1",
      physicalDeviceId: "physical-1",
      accessLevel: "general",
      status: "active",
      tokenGeneration: 1,
    };
    send
      .mockResolvedValueOnce({ Item: binding })
      .mockResolvedValueOnce({
        Item: {
          ...binding,
          sk: "DEVICE#general-1",
          tokenGeneration: 3,
        },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      revokeGeneralBinding,
      event({ pathParameters: { bindingId: "general-1" } }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(
      transaction.input.TransactItems[1].Update.ExpressionAttributeValues[
        ":current"
      ],
    ).toBe(3);
  });
});

/** @param {{accessLevel?: string, body?: unknown, pathParameters?: Record<string, string>}} [options] */
function event(options = {}) {
  return {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    pathParameters: options.pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "custom:siteId": "site-1",
            accessLevel: options.accessLevel ?? "manager",
            sub: "manager-1",
          },
        },
      },
    },
  };
}

/** @param {Function} handler @param {any} request */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, /** @type {any} */ ({}), () => {})
  );
}
