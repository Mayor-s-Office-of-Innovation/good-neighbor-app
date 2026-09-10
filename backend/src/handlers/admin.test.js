import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  createMasterContact,
  createProvider,
  createSite,
  deactivateProvider,
  deactivateSite,
  deactivateMasterContact,
  issueAdminSetupCode,
  listProviders,
  revokeDevice,
  updateSite,
} = await import("./admin.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
});

describe("admin authorization", () => {
  it("rejects callers outside the central-admin group", async () => {
    const res = await call(listProviders, event(undefined, ""));
    expect(res.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("provider and site management", () => {
  it("creates providers", async () => {
    send.mockResolvedValue({});

    const res = await call(createProvider, event({ name: "Provider One" }));

    expect(res.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutCommand);
    expect(JSON.parse(res.body).provider).toMatchObject({
      providerId: "provider-one",
      name: "Provider One",
      status: "active",
    });
  });

  it("creates sites under providers", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          providerId: "provider-one",
          name: "Provider One",
          status: "active",
        },
      })
      .mockResolvedValue({});

    const res = await call(
      createSite,
      event({ name: "Main Site" }, "central-admin", {
        providerId: "provider-one",
      }),
    );

    expect(res.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(TransactWriteCommand);
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx.input.TransactItems).toHaveLength(3);
    expect(tx.input.TransactItems?.[0]).toMatchObject({
      Put: {
        Item: {
          pk: "SITE#provider-one-main-site",
          sk: "#META",
        },
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });
    expect(tx.input.TransactItems?.[1]).toMatchObject({
      Put: {
        Item: {
          pk: "PROVIDER#provider-one",
          sk: "SITE#provider-one-main-site",
        },
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });
    expect(tx.input.TransactItems?.[2]).toMatchObject({
      Put: {
        Item: {
          pk: "SITE_SEARCH#ACTIVE",
          sk: "main site#provider-one-main-site",
        },
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    });
    expect(JSON.parse(res.body).site).toMatchObject({
      siteId: "provider-one-main-site",
      providerId: "provider-one",
      name: "Main Site",
    });
  });

  it("does not write site companion records outside the create transaction", async () => {
    const conflict = new Error("duplicate");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({
        Item: {
          providerId: "provider-one",
          name: "Provider One",
          status: "active",
        },
      })
      .mockRejectedValueOnce(conflict);

    await expect(
      call(
        createSite,
        event({ name: "Main Site" }, "central-admin", {
          providerId: "provider-one",
        }),
      ),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(TransactWriteCommand);
  });

  it("adds master contacts to a site", async () => {
    send.mockResolvedValue({});

    const res = await call(
      createMasterContact,
      event({ email: "Lead@Example.org", name: "Site Lead" }, "central-admin", {
        siteId: "site-1",
      }),
    );

    expect(res.statusCode).toBe(201);
    const put = /** @type {PutCommand} */ (send.mock.calls[0][0]);
    expect(put.input.Item).toMatchObject({
      pk: "SITE#site-1",
      type: "masterContact",
      email: "lead@example.org",
      status: "active",
    });
  });

  it("revokes pending setup codes when removing master contacts", async () => {
    send
      .mockResolvedValueOnce({
        Attributes: {
          pk: "SITE#site-1",
          sk: "MASTER_CONTACT#contact-hash",
          emailHash: "contact-hash",
          status: "inactive",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SETUP_CODE#old",
            sk: "#META",
            status: "pending",
            gsi6pk: "SETUP_CODE_PENDING#site-1#contact-hash",
            gsi6sk: "2026-01-01T00:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const res = await call(
      deactivateMasterContact,
      event(undefined, "central-admin", {
        siteId: "site-1",
        emailHash: "contact-hash",
      }),
    );

    expect(res.statusCode).toBe(200);
    const query = /** @type {QueryCommand} */ (send.mock.calls[1][0]);
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input.ExpressionAttributeValues).toMatchObject({
      ":pk": "SETUP_CODE_PENDING#site-1#contact-hash",
    });
    const revoke = /** @type {PutCommand} */ (send.mock.calls[2][0]);
    expect(revoke.input.Item).toMatchObject({
      pk: "SETUP_CODE#old",
      status: "revoked",
      revokedReason: "contact_removed",
    });
    expect(revoke.input.Item?.gsi6pk).toBeUndefined();
  });

  it("lists providers from the provider search partition", async () => {
    send.mockResolvedValueOnce({ Items: [{ providerId: "p1" }] });
    const res = await call(listProviders, event());

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(JSON.parse(res.body)).toEqual({
      providers: [{ providerId: "p1" }],
    });
  });

  it("lists providers across all provider search pages", async () => {
    send
      .mockResolvedValueOnce({
        Items: [{ providerId: "p1" }],
        LastEvaluatedKey: { pk: "PROVIDER_SEARCH#ACTIVE", sk: "p1" },
      })
      .mockResolvedValueOnce({ Items: [{ providerId: "p2" }] });

    const res = await call(listProviders, event());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      providers: [{ providerId: "p1" }, { providerId: "p2" }],
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: "PROVIDER_SEARCH#ACTIVE",
      sk: "p1",
    });
  });

  it("deactivates active sites when deactivating a provider", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            siteId: "site-1",
            siteName: "City Hall",
            status: "active",
          },
          {
            siteId: "site-2",
            siteName: "Library",
            status: "active",
          },
          {
            siteId: "site-3",
            siteName: "Closed Site",
            status: "inactive",
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Attributes: {
          providerId: "provider-one",
          status: "inactive",
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });

    const res = await call(
      deactivateProvider,
      event(undefined, "central-admin", { providerId: "provider-one" }),
    );

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":pk": "PROVIDER#provider-one",
        ":site": "SITE#",
      },
    );
    const siteTransactions = send.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd instanceof TransactWriteCommand);
    expect(siteTransactions).toHaveLength(2);
    expect(siteTransactions[0].input.TransactItems).toMatchObject([
      {
        Update: {
          Key: { pk: "SITE#site-1", sk: "#META" },
        },
      },
      {
        Update: {
          Key: { pk: "PROVIDER#provider-one", sk: "SITE#site-1" },
        },
      },
      {
        Delete: {
          Key: { pk: "SITE_SEARCH#ACTIVE", sk: "city hall#site-1" },
        },
      },
    ]);
    expect(siteTransactions[1].input.TransactItems?.[0]).toMatchObject({
      Update: { Key: { pk: "SITE#site-2", sk: "#META" } },
    });
    expect(
      siteTransactions.some((tx) =>
        tx.input.TransactItems?.some(
          (item) => item.Update?.Key?.pk === "SITE#site-3",
        ),
      ),
    ).toBe(false);
    const providerUpdate = send.mock.calls
      .map(([cmd]) => cmd)
      .find(
        (cmd) =>
          cmd instanceof UpdateCommand &&
          cmd.input.Key?.pk === "PROVIDER#provider-one" &&
          cmd.input.Key?.sk === "#META",
      );
    expect(providerUpdate?.input.UpdateExpression).toContain("#status");
    const providerSearchDelete = send.mock.calls
      .map(([cmd]) => cmd)
      .find(
        (cmd) =>
          cmd instanceof DeleteCommand &&
          cmd.input.Key?.pk === "PROVIDER_SEARCH#ACTIVE",
      );
    expect(providerSearchDelete?.input.Key).toEqual({
      pk: "PROVIDER_SEARCH#ACTIVE",
      sk: "provider-one",
    });
  });

  it("issues setup codes for central support", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          providerSiteId: "provider-site-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const res = await call(
      issueAdminSetupCode,
      event({ email: "lead@example.org" }, "central-admin", {
        siteId: "site-1",
      }),
    );

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.setupCode).toMatchObject({
      issuedTo: "lead@example.org",
      siteId: "site-1",
      siteName: "City Hall",
      maxUses: 3,
      uses: 0,
    });
    expect(body.setupCode.code).toMatch(/^[A-Z0-9]{6}$/);
  });

  it("revokes devices by bumping token generation", async () => {
    send.mockResolvedValueOnce({ Attributes: { deviceId: "dev-1" } });

    const res = await call(
      revokeDevice,
      event(undefined, "central-admin", {
        siteId: "site-1",
        deviceId: "dev-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    const update = /** @type {any} */ (send.mock.calls[0][0]);
    expect(update.input.UpdateExpression).toContain("tokenGeneration");
  });

  it("removes the public search record when deactivating sites", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          status: "active",
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SETUP_CODE#old",
            sk: "#META",
            status: "pending",
            gsi7pk: "SETUP_CODE_PENDING_SITE#site-1",
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [{ pk: "SITE#site-1", sk: "DEVICE#dev-1" }],
      })
      .mockResolvedValue({});

    const res = await call(
      deactivateSite,
      event(undefined, "central-admin", { siteId: "site-1" }),
    );

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    expect(tx.input.TransactItems?.[1]).toMatchObject({
      Delete: {
        Key: {
          pk: "SITE_SEARCH#ACTIVE",
          sk: "city hall#site-1",
        },
      },
    });
    const setupCodeQuery = send.mock.calls
      .map(([cmd]) => cmd)
      .find(
        (cmd) => cmd instanceof QueryCommand && cmd.input.IndexName === "GSI7",
      );
    expect(setupCodeQuery?.input.ExpressionAttributeValues).toMatchObject({
      ":pk": "SETUP_CODE_PENDING_SITE#site-1",
    });
    const setupCodeRevoke = send.mock.calls
      .map(([cmd]) => cmd)
      .find(
        (cmd) => cmd instanceof PutCommand && cmd.input.Item?.type !== "site",
      );
    expect(setupCodeRevoke?.input.Item).toMatchObject({
      pk: "SETUP_CODE#old",
      status: "revoked",
      revokedReason: "site_deactivated",
    });
    const deviceRevoke = send.mock.calls
      .map(([cmd]) => cmd)
      .find(
        (cmd) =>
          cmd instanceof UpdateCommand && cmd.input.Key?.sk === "DEVICE#dev-1",
      );
    expect(deviceRevoke?.input.UpdateExpression).toContain("tokenGeneration");
    expect(JSON.parse(res.body).site).toMatchObject({
      siteId: "site-1",
      status: "inactive",
    });
  });

  it("updates provider membership and public search records when renaming sites", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          providerId: "provider-one",
          providerName: "Provider One",
          providerSiteId: "provider-site-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({});

    const res = await call(
      updateSite,
      event({ name: "Civic Center" }, "central-admin", { siteId: "site-1" }),
    );

    expect(res.statusCode).toBe(200);
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    expect(tx.input.TransactItems?.[1]).toMatchObject({
      Update: {
        Key: { pk: "PROVIDER#provider-one", sk: "SITE#site-1" },
        UpdateExpression: expect.stringContaining("siteName"),
      },
    });
    expect(tx.input.TransactItems?.[2]).toMatchObject({
      Delete: {
        Key: { pk: "SITE_SEARCH#ACTIVE", sk: "city hall#site-1" },
      },
    });
    expect(tx.input.TransactItems?.[3]).toMatchObject({
      Put: {
        Item: {
          pk: "SITE_SEARCH#ACTIVE",
          sk: "civic center#site-1",
          siteName: "Civic Center",
          label: "Civic Center (Provider One)",
          searchText: "civic center provider one",
        },
      },
    });
    expect(JSON.parse(res.body).site).toMatchObject({
      siteId: "site-1",
      name: "Civic Center",
    });
  });
});

/**
 * @param {unknown} [body]
 * @param {string} [groups]
 * @param {Record<string,string>} [pathParameters]
 * @returns {any}
 */
function event(body, groups = "central-admin", pathParameters = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "cognito:groups": groups,
          },
        },
      },
    },
  };
}

/**
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {any} evt
 * @returns {Promise<any>}
 */
function call(handler, evt) {
  return Promise.resolve(handler(evt, /** @type {any} */ ({}), () => {}));
}
