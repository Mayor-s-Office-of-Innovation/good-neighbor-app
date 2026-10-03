import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { listDeviceBindings, selectDeviceBinding } = await import(
  "./device-bindings.js"
);

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("DEVICE_TOKEN_SECRET", "test-device-secret-at-least-32-bytes");
});

describe("physical-device Site bindings", () => {
  it("lists only current bindings owned by the authenticated physical device", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          deviceId: "binding-current",
          physicalDeviceId: "physical-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Items: [pointer("binding-2", "site-2")],
      })
      .mockResolvedValueOnce({ Item: binding("binding-2", "site-2") })
      .mockResolvedValueOnce({
        Item: {
          deviceId: "binding-2",
          status: "active",
          lastSeenAt: "2026-10-03T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-2",
          name: "Second Site",
          status: "active",
          siteCredentialGeneration: 0,
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active", generation: 1 } });

    const response = await call(listDeviceBindings, event());
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    expect(JSON.parse(String(response.body))).toMatchObject({
      physicalDeviceId: "physical-1",
      currentBindingId: "binding-current",
      bindings: [
        {
          bindingId: "binding-2",
          siteId: "site-2",
          siteName: "Second Site",
          accessLevel: "manager",
        },
      ],
    });
  });

  it("selects an owned binding and rotates its session atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          deviceId: "binding-current",
          physicalDeviceId: "physical-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Item: pointer("binding-2", "site-2") })
      .mockResolvedValueOnce({ Item: binding("binding-2", "site-2") })
      .mockResolvedValueOnce({
        Item: {
          pk: "SITE#site-2",
          sk: "DEVICE#binding-2",
          deviceId: "binding-2",
          tokenGeneration: 3,
          status: "active",
          lastSeenAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-2",
          name: "Second Site",
          status: "active",
          siteCredentialGeneration: 0,
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active", generation: 1 } })
      .mockResolvedValueOnce({});

    const response = await call(
      selectDeviceBinding,
      event({ bindingId: "binding-2" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toMatchObject({
      physicalDeviceId: "physical-1",
      bindingId: "binding-2",
      site: { siteId: "site-2", name: "Second Site" },
      accessLevel: "manager",
      tokenGeneration: 4,
    });
    const transaction = send.mock.calls[6][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems[2].Put.Item).toMatchObject({
      eventType: "device_binding_selected",
      bindingId: "binding-2",
      previousBindingId: "binding-current",
      physicalDeviceId: "physical-1",
    });
  });

  it("does not select a binding without a pointer owned by this device", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          deviceId: "binding-current",
          physicalDeviceId: "physical-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      selectDeviceBinding,
      event({ bindingId: "someone-elses-binding" }),
    );
    expect(response.statusCode).toBe(404);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

/** @param {string} bindingId @param {string} siteId */
function pointer(bindingId, siteId) {
  return {
    physicalDeviceId: "physical-1",
    bindingId,
    siteId,
    status: "active",
  };
}

/** @param {string} bindingId @param {string} siteId */
function binding(bindingId, siteId) {
  return {
    pk: `SITE#${siteId}`,
    sk: `DEVICE_BINDING#${bindingId}`,
    bindingId,
    physicalDeviceId: "physical-1",
    siteId,
    accessLevel: "manager",
    membershipId: "membership-1",
    membershipGeneration: 1,
    siteCredentialGeneration: 0,
    inactivityLimitDays: 60,
    tokenGeneration: 1,
    status: "active",
    enrolledAt: "2026-10-01T00:00:00.000Z",
    absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
  };
}

/** @param {unknown} body */
function event(body = undefined) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "custom:siteId": "site-1",
            sub: "binding-current",
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
