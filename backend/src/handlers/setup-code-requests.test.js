import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const res = await callRequest({
      siteId: "site-1",
      email: "Lead@Example.org",
    });

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).message).toContain("If that email");
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
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
