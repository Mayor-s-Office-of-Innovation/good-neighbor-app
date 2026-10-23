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
          claims: { "cognito:groups": "compliance-supervisor", sub: "admin-1" },
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

describe("manager devices across sites", () => {
  async function fixture({ count = 2, failBatch = 0, retained = false } = {}) {
    const { emailHash } = await import("./setup-codes.js");
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-secret");
    const hash = await emailHash("manager@example.org");
    let writes = 0;
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item: {
            userId: "user-1",
            email: "manager@example.org",
            siteManager: true,
          },
        };
      if (command instanceof QueryCommand) {
        const { ":pk": pk, ":prefix": prefix } =
          command.input.ExpressionAttributeValues || {};
        if (pk === `MANAGER_EMAIL#${hash}`)
          return {
            Items: retained ? [] : [{ siteId: "site-1" }, { siteId: "site-2" }],
          };
        if (pk === "PROGRAM#program-1") return { Items: [] };
        if (pk === "SITE_SEARCH#ACTIVE")
          return {
            Items: retained ? [{ siteId: "site-1" }, { siteId: "site-2" }] : [],
          };
        if (prefix === "MANAGER_MEMBERSHIP#")
          return {
            Items: [
              {
                membershipId: "member-1",
                userId: "user-1",
                programId: "program-1",
              },
              {
                membershipId: "other",
                userId: "user-2",
                programId: "program-1",
              },
              {
                membershipId: "collision",
                userId: "user-1",
                programId: "different-program",
              },
            ],
          };
        if (prefix === "DEVICE_BINDING#")
          return {
            Items: [
              ...Array.from(
                { length: pk === "SITE#site-1" ? count - 1 : 1 },
                (_, i) => ({
                  ...binding(`${pk}-device-${i}`, `${pk}-physical-${i}`, 1),
                  pk,
                  sk: `DEVICE_BINDING#${pk}-device-${i}`,
                  siteId: pk.slice(5),
                  accessLevel: "manager",
                  membershipId: "member-1",
                }),
              ),
              {
                ...binding("team", "team-physical", 1),
                membershipId: "member-1",
              },
              {
                ...binding("other", "other-physical", 1),
                accessLevel: "manager",
                membershipId: "other",
              },
              {
                ...binding("collision", "collision-physical", 1),
                accessLevel: "manager",
                membershipId: "collision",
              },
              {
                ...binding("provider", "provider-physical", 1),
                accessLevel: "manager",
                authorityScope: "provider",
                membershipId: "member-1",
              },
              {
                ...binding("revoked", "revoked-physical", 1),
                accessLevel: "manager",
                membershipId: "member-1",
                status: "revoked",
              },
            ],
          };
      }
      if (command instanceof TransactWriteCommand) {
        if (++writes === failBatch) throw new Error("conflict");
        return {};
      }
      throw new Error("unexpected command");
    });
    return (await import("./admin-device-revocation.js")).revokeManagerDevices;
  }

  it("revokes own manager bindings at every site, preserving assignments and team devices", async () => {
    const handler = await fixture();
    const response = await call(
      handler,
      event(
        { confirmation: "manager@example.org" },
        { programId: "program-1", userId: "user-1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).affectedCount).toBe(2);
    const writes = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof TransactWriteCommand);
    expect(writes).toHaveLength(1);
    const items = writes[0].input.TransactItems || [];
    expect(items).toHaveLength(7);
    expect(
      items
        .filter((item) => item.Update)
        .every((item) => /DEVICE|BINDING/.test(item.Update?.Key?.sk)),
    ).toBe(true);
    expect(JSON.stringify(items)).not.toContain("ASSIGNED_USER");
    expect(JSON.stringify(items)).not.toContain("team-physical");
    expect(items.at(-1)?.Put?.Item?.eventType).toBe("manager_devices_revoked");
  });

  it("finds retained memberships outside the current program without email pointers", async () => {
    const handler = await fixture({ retained: true });
    const response = await call(
      handler,
      event(
        { confirmation: "manager@example.org" },
        { programId: "program-1", userId: "user-1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).affectedCount).toBe(2);
    const writes = send.mock.calls.filter(
      ([c]) => c instanceof TransactWriteCommand,
    );
    expect(JSON.stringify(writes)).not.toContain("collision-physical");
    expect(JSON.stringify(writes)).not.toContain("provider-physical");
  });

  it("authorizes every retained site before starting any revocation batch", async () => {
    const handler = await fixture({ retained: true });
    const original = send.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        const { pk, sk } = command.input.Key || {};
        if (pk === "ADMIN_DIRECTORY#PROGRAM_MANAGERS")
          return { Item: { userId: "cm", status: "active" } };
        if (sk === "COMPLIANCE_MANAGER#cm")
          return {
            Item: pk === "SITE#site-1" ? { status: "active" } : undefined,
          };
      }
      return original(command);
    });
    const request = event(
      { confirmation: "manager@example.org" },
      { programId: "program-1", userId: "user-1" },
    );
    Object.assign(request.requestContext.authorizer.jwt.claims, {
      "cognito:groups": "compliance-manager",
      email: "cm@example.org",
    });
    expect((await call(handler, request)).statusCode).toBe(403);
    expect(
      send.mock.calls.some(([c]) => c instanceof TransactWriteCommand),
    ).toBe(false);
  });

  it("requires confirmation and admin authorization before writes", async () => {
    const handler = await fixture();
    const request = event(
      { confirmation: "wrong" },
      { programId: "program-1", userId: "user-1" },
    );
    expect((await call(handler, request)).statusCode).toBe(400);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
    send.mockClear();
    request.requestContext.authorizer.jwt.claims["cognito:groups"] =
      "site-manager";
    expect((await call(handler, request)).statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("reports partial batch failures instead of claiming complete revocation", async () => {
    const handler = await fixture({ count: 22, failBatch: 2 });
    const response = await call(
      handler,
      event(
        { confirmation: "manager@example.org" },
        { programId: "program-1", userId: "user-1" },
      ),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toMatchObject({
      status: "incomplete",
      affectedCount: 20,
    });
  });
});
