import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("../db.js", () => ({
  ddb: { send },
}));

const { handler, normalizeSiteCode } = await import("./site-code.js");

describe("normalizeSiteCode", () => {
  it("removes visual separators and uppercases letters", () => {
    expect(normalizeSiteCode(" hcm-4820 ")).toBe("HCM4820");
    expect(normalizeSiteCode("123 456")).toBe("123456");
  });
});

describe("site-code handler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    send.mockReset();
  });

  it("returns a provider site for an active code", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    send.mockResolvedValueOnce({
      Item: {
        active: true,
        providerSiteId: "provider-site-1",
        siteId: "site-1",
        siteName: "City Hall",
      },
    });

    const res = await callHandler({ code: "123-456" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "gnp-test-app",
          Key: { pk: "SITE_CODE#123456", sk: "#META" },
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      code: "123456",
      providerSite: {
        id: "provider-site-1",
        siteId: "site-1",
        name: "City Hall",
      },
    });
  });

  it("rejects inactive or unknown codes with a generic error", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    send.mockResolvedValueOnce({ Item: { active: false } });

    const res = await callHandler({ code: "000000" });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_site_code" });
  });

  it("requires a code", async () => {
    const res = await callHandler({ code: "" });

    expect(send).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "missing_site_code" });
  });
});

/**
 * @param {unknown} body
 * @returns {import("aws-lambda").APIGatewayProxyEventV2}
 */
function event(body) {
  return /** @type {import("aws-lambda").APIGatewayProxyEventV2} */ ({
    body: JSON.stringify(body),
  });
}

/**
 * @param {unknown} body
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
async function callHandler(body) {
  return /** @type {import("aws-lambda").APIGatewayProxyResult} */ (
    await handler(event(body), /** @type {any} */ ({}), () => {})
  );
}
