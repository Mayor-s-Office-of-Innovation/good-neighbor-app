import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
const { sendSetupCodeEmail } = vi.hoisted(() => ({
  sendSetupCodeEmail: vi.fn().mockResolvedValue({
    provider: "log",
    messageId: "msg-1",
  }),
}));

vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/email.js", () => ({ sendSetupCodeEmail }));

const { requestSetupCode, searchSites } = await import(
  "./setup-code-requests.js"
);

beforeEach(() => {
  send.mockReset();
  sendSetupCodeEmail.mockClear();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
  vi.stubEnv("PROVIDER_APP_URL", "https://goodneighborsf.org/");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("searchSites", () => {
  it("returns public-safe site search results", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          siteId: "site-1",
          providerSiteId: "provider-site-1",
          siteName: "City Hall",
          providerName: "MOI",
          label: "City Hall (MOI)",
        },
      ],
    });

    const res = await call(
      searchSites,
      /** @type {any} */ ({ queryStringParameters: { q: "city" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      sites: [
        {
          siteId: "site-1",
          providerSiteId: "provider-site-1",
          name: "City Hall",
          providerName: "MOI",
          label: "City Hall (MOI)",
        },
      ],
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
  });

  it("continues searching later pages until enough matches are collected", async () => {
    send
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: { pk: "SITE_SEARCH#ACTIVE", sk: "first-page" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            siteId: "site-2",
            providerSiteId: "provider-site-2",
            siteName: "St. John",
            providerName: "Gubbio",
            label: "St. John (Gubbio)",
          },
        ],
      });

    const res = await call(
      searchSites,
      /** @type {any} */ ({ queryStringParameters: { q: "john" } }),
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sites).toEqual([
      {
        siteId: "site-2",
        providerSiteId: "provider-site-2",
        name: "St. John",
        providerName: "Gubbio",
        label: "St. John (Gubbio)",
      },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({
      pk: "SITE_SEARCH#ACTIVE",
      sk: "first-page",
    });
  });
});

describe("requestSetupCode", () => {
  it("returns the generic response and emails authorized contacts", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          providerSiteId: "provider-site-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const res = await callRequest({
      siteId: "site-1",
      email: "Lead@Example.org",
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).message).toContain("If that email");
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const throttle = /** @type {PutCommand} */ (send.mock.calls[3][0]);
    expect(throttle).toBeInstanceOf(PutCommand);
    expect(throttle.input.Item?.pk).toMatch(/^SETUP_CODE_REQUEST#site-1#/);
    expect(sendSetupCodeEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "lead@example.org",
        siteName: "City Hall",
        code: expect.stringMatching(/^[A-Z0-9]{6}$/),
      }),
    );
  });

  it("returns the same generic response for unauthorized contacts without email", async () => {
    send
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", name: "City Hall", status: "active" },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await callRequest({
      siteId: "site-1",
      email: "unknown@example.org",
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).message).toContain("If that email");
    expect(sendSetupCodeEmail).not.toHaveBeenCalled();
  });

  it("authorizes an active master contact when code-contact is inactive", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          providerSiteId: "provider-site-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "inactive" } })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const res = await callRequest({
      siteId: "site-1",
      email: "lead@example.org",
    });

    expect(res.statusCode).toBe(202);
    expect(sendSetupCodeEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "lead@example.org",
        siteName: "City Hall",
      }),
    );
  });

  it("returns the generic response without issuing when the request is throttled", async () => {
    const throttled = new Error("cooldown");
    throttled.name = "ConditionalCheckFailedException";
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          providerSiteId: "provider-site-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(throttled);

    const res = await callRequest({
      siteId: "site-1",
      email: "lead@example.org",
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).message).toContain("If that email");
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3][0]).toBeInstanceOf(PutCommand);
    expect(sendSetupCodeEmail).not.toHaveBeenCalled();
  });
});

/**
 * @param {unknown} body
 * @returns {Promise<any>}
 */
function callRequest(body) {
  return call(
    requestSetupCode,
    /** @type {any} */ ({ body: JSON.stringify(body) }),
  );
}

/**
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {any} evt
 * @returns {Promise<any>}
 */
function call(handler, evt) {
  return Promise.resolve(handler(evt, /** @type {any} */ ({}), () => {}));
}
