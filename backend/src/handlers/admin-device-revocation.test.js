import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  getPhysicalDeviceRevocationPreview,
  revokeAllSiteDeviceBindings,
  revokePhysicalDeviceEverywhere,
  revokeSelectedDeviceBindings,
  suspendDeviceBinding,
} = await import("./admin-device-revocation.js");

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

describe("City physical-device-wide revocation", () => {
  it("returns a safe preview of every active Site binding", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          physicalDeviceId: "physical-1",
          label: "Shared tablet",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            siteId: "site-1",
            bindingId: "binding-1",
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: {
          ...binding("binding-1", "physical-1", 2),
          refreshJti: "must-not-leak",
        },
      })
      .mockResolvedValueOnce({ Item: { name: "Site One" } });

    const response = await call(
      getPhysicalDeviceRevocationPreview,
      event({}, { physicalDeviceId: "physical-1" }),
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    const payload = JSON.parse(String(response.body));
    expect(payload.physicalDevice).toEqual({
      physicalDeviceId: "physical-1",
      label: "Shared tablet",
      status: "active",
      bindingLimitExceeded: false,
      bindings: [
        {
          bindingId: "binding-1",
          siteId: "site-1",
          siteName: "Site One",
          accessLevel: "general",
          status: "active",
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });

  it("continues past pages containing only revoked binding pointers", async () => {
    const cursor = {
      pk: "PHYSICAL_DEVICE#physical-1",
      sk: "BINDING#revoked",
    };
    send
      .mockResolvedValueOnce({
        Item: {
          physicalDeviceId: "physical-1",
          label: "Shared tablet",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Items: [{ bindingId: "revoked", status: "revoked" }],
        LastEvaluatedKey: cursor,
      })
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", bindingId: "binding-1", status: "active" }],
      })
      .mockResolvedValueOnce({
        Item: binding("binding-1", "physical-1", 2),
      })
      .mockResolvedValueOnce({ Item: { name: "Site One" } });

    const response = await call(
      getPhysicalDeviceRevocationPreview,
      event({}, { physicalDeviceId: "physical-1" }),
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[2][0].input.ExclusiveStartKey).toEqual(cursor);
    expect(JSON.parse(String(response.body)).physicalDevice.bindings).toEqual([
      expect.objectContaining({ bindingId: "binding-1" }),
    ]);
  });

  it("revokes the physical record and every binding in one transaction", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          physicalDeviceId: "physical-1",
          label: "Shared tablet",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            siteId: "site-1",
            bindingId: "binding-1",
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: binding("binding-1", "physical-1", 2),
      })
      .mockResolvedValueOnce({ Item: { name: "Site One" } })
      .mockResolvedValueOnce({});

    const response = await call(
      revokePhysicalDeviceEverywhere,
      event(
        { confirmation: "Shared tablet" },
        { physicalDeviceId: "physical-1" },
      ),
    );

    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[4][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(6);
    expect(transaction.input.TransactItems[0].Update.Key).toEqual({
      pk: "PHYSICAL_DEVICE#physical-1",
      sk: "#META",
    });
    expect(transaction.input.TransactItems[1].Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "DEVICE_BINDING#binding-1",
    });
    expect(transaction.input.TransactItems[5].Put.Item).toMatchObject({
      type: "revocationOperation",
      scope: "physical_device",
      affectedSiteIds: ["site-1"],
      affectedCount: 1,
      status: "complete",
    });
    expect(JSON.parse(String(response.body))).toMatchObject({
      status: "complete",
      affectedCount: 1,
      affectedSites: [{ siteId: "site-1", siteName: "Site One" }],
    });
  });

  it("requires the exact device label before changing any record", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          physicalDeviceId: "physical-1",
          label: "Shared tablet",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Items: [] });

    const response = await call(
      revokePhysicalDeviceEverywhere,
      event(
        { confirmation: "shared tablet" },
        { physicalDeviceId: "physical-1" },
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("City device-binding suspension", () => {
  it("suspends every projection and advances the binding generation", async () => {
    send
      .mockResolvedValueOnce({ Item: binding("binding-1", "physical-1", 4) })
      .mockResolvedValueOnce({});

    const response = await call(
      suspendDeviceBinding,
      event(
        { reason: "security_review" },
        { siteId: "site-1", bindingId: "binding-1" },
      ),
    );

    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(4);
    expect(transaction.input.TransactItems[0].Update.Key).toEqual({
      pk: "SITE#site-1",
      sk: "DEVICE_BINDING#binding-1",
    });
    expect(
      transaction.input.TransactItems[0].Update.ExpressionAttributeValues,
    ).toMatchObject({
      ":suspended": "suspended",
      ":reason": "security_review",
      ":next": 5,
    });
    expect(transaction.input.TransactItems[2].Update.Key).toEqual({
      pk: "PHYSICAL_DEVICE#physical-1",
      sk: "BINDING#binding-1",
    });
    expect(transaction.input.TransactItems[3].Put.Item).toMatchObject({
      type: "siteAuditEvent",
      eventType: "device_binding_suspended",
      reason: "security_review",
    });
    expect(JSON.parse(String(response.body))).toMatchObject({
      binding: {
        bindingId: "binding-1",
        status: "suspended",
        tokenGeneration: 5,
        suspendedReason: "security_review",
      },
    });
  });

  it("does not reactivate an already suspended binding", async () => {
    send.mockResolvedValueOnce({
      Item: {
        ...binding("binding-1", "physical-1", 5),
        status: "suspended",
        suspendedAt: "2026-10-03T12:00:00.000Z",
        suspendedReason: "security_review",
      },
    });

    const response = await call(
      suspendDeviceBinding,
      event(
        { reason: "policy_violation" },
        { siteId: "site-1", bindingId: "binding-1" },
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(response.body))).toMatchObject({
      alreadySuspended: true,
      binding: {
        status: "suspended",
        suspendedReason: "security_review",
      },
    });
  });

  it("rejects an unrecognized suspension reason", async () => {
    const response = await call(
      suspendDeviceBinding,
      event(
        { reason: "because" },
        { siteId: "site-1", bindingId: "binding-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
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

/** @param {Record<string, unknown>} body @param {Record<string, string>} [pathParameters] */
function event(body, pathParameters = { siteId: "site-1" }) {
  return /** @type {any} */ ({
    body: JSON.stringify(body),
    pathParameters,
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
