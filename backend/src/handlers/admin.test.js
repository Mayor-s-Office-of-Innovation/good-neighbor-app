import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  createMasterContact,
  createProvider,
  createSite,
  issueAdminSetupCode,
  listProviders,
  revokeDevice,
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
    expect(JSON.parse(res.body).site).toMatchObject({
      siteId: "provider-one-main-site",
      providerId: "provider-one",
      name: "Main Site",
    });
  });

  it("adds master contacts to a site", async () => {
    send.mockResolvedValue({});

    const res = await call(
      createMasterContact,
      event(
        { email: "Lead@Example.org", name: "Site Lead" },
        "central-admin",
        { siteId: "site-1" },
      ),
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

  it("lists providers from the provider search partition", async () => {
    send.mockResolvedValueOnce({ Items: [{ providerId: "p1" }] });
    const res = await call(listProviders, event());

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(JSON.parse(res.body)).toEqual({
      providers: [{ providerId: "p1" }],
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
    expect(JSON.parse(res.body).setupCode.code).toMatch(/^[A-Z0-9]{6}$/);
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
