import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { revokeAllSiteDeviceBindings, revokeSelectedDeviceBindings } =
  await import("./admin-device-revocation.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("City selected binding revocation", () => {
  it("revokes every selected canonical projection in one transaction", async () => {
    send
      .mockResolvedValueOnce({ Item: binding("binding-1", "physical-1", 2) })
      .mockResolvedValueOnce({ Item: binding("binding-2", "physical-2", 7) })
      .mockResolvedValueOnce({});

    const response = await call(
      revokeSelectedDeviceBindings,
      event({ bindingIds: ["binding-1", "binding-2"] }),
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(8);
    expect(transaction.input.TransactItems[0].Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "DEVICE_BINDING#binding-1",
    });
    expect(
      transaction.input.TransactItems[0].Update.ExpressionAttributeValues,
    ).toMatchObject({ ":next": 3 });
    expect(
      transaction.input.TransactItems[3].Update.ExpressionAttributeValues,
    ).toMatchObject({ ":next": 8 });
    expect(transaction.input.TransactItems[6].Put.Item).toMatchObject({
      type: "revocationOperation",
      scope: "selected_bindings",
      affectedCount: 2,
      status: "complete",
    });
    expect(JSON.parse(String(response.body))).toMatchObject({
      status: "complete",
      affectedCount: 2,
      alreadyRevokedCount: 0,
    });
  });

  it("rejects an unknown binding before changing any credential", async () => {
    send.mockResolvedValueOnce({});
    const response = await call(
      revokeSelectedDeviceBindings,
      event({ bindingIds: ["missing"] }),
    );
    expect(response.statusCode).toBe(404);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("City Site-wide revocation", () => {
  it("requires the exact Site name before reading device bindings", async () => {
    send.mockResolvedValueOnce({
      Item: { siteId: "site-1", name: "Site One", siteCredentialGeneration: 4 },
    });
    const response = await call(
      revokeAllSiteDeviceBindings,
      event({ confirmation: "site one" }),
    );
    expect(response.statusCode).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("invalidates the Site generation before reconciling binding rows", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          siteCredentialGeneration: 4,
        },
      })
      .mockResolvedValueOnce({
        Items: [binding("binding-1", "physical-1", 2)],
      })
      .mockResolvedValueOnce({
        Items: [{ deviceId: "binding-1", bindingId: "binding-1" }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const response = await call(
      revokeAllSiteDeviceBindings,
      event({ confirmation: "Site One" }),
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    const invalidate = send.mock.calls[3][0];
    expect(invalidate).toBeInstanceOf(TransactWriteCommand);
    expect(
      invalidate.input.TransactItems[0].Update.ExpressionAttributeValues,
    ).toMatchObject({ ":current": 4, ":next": 5 });
    const reconcile = send.mock.calls[4][0];
    expect(reconcile).toBeInstanceOf(TransactWriteCommand);
    expect(send.mock.calls[5][0]).toBeInstanceOf(UpdateCommand);
    expect(JSON.parse(String(response.body))).toMatchObject({
      status: "complete",
      affectedCount: 1,
      failedCount: 0,
      siteCredentialGeneration: 5,
    });
  });
});

/** @param {string} bindingId @param {string} physicalDeviceId @param {number} tokenGeneration */
function binding(bindingId, physicalDeviceId, tokenGeneration) {
  return {
    pk: "SITE#site-1",
    sk: `DEVICE_BINDING#${bindingId}`,
    bindingId,
    physicalDeviceId,
    siteId: "site-1",
    accessLevel: "general",
    status: "active",
    tokenGeneration,
  };
}

/** @param {Record<string, unknown>} body */
function event(body) {
  return /** @type {any} */ ({
    body: JSON.stringify(body),
    pathParameters: { siteId: "site-1" },
    requestContext: {
      authorizer: {
        jwt: {
          claims: { "cognito:groups": "central-admin", sub: "admin-1" },
        },
      },
    },
  });
}

/** @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler @param {any} request */
async function call(handler, request) {
  return /** @type {any} */ (
    await handler(request, /** @type {any} */ ({}), () => {})
  );
}
