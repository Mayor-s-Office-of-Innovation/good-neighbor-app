import { checkCodeAttemptLimit } from "./code-attempt-limit.js";
vi.mock("./code-attempt-limit.js", () => ({
  checkCodeAttemptLimit: vi.fn(async () => null),
}));
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

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

  it("recognizes a six-character manager code without redeeming it", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
    send.mockResolvedValueOnce({ Item: { grantId: "grant-1" } });
    const response = await callHandler({ code: "0AB123" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      code: "0AB123",
      enrollment: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  it("returns a provider site for an active code", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
    send
      .mockResolvedValueOnce({}) // enrollment-code lookup
      .mockResolvedValueOnce({}) // dynamic setup-code lookup
      .mockResolvedValueOnce({
        Item: {
          active: true,
          providerSiteId: "provider-site-1",
          siteId: "site-1",
          siteName: "City Hall",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "active" } });

    const res = await callHandler({ code: "123-456" });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "gnp-test-app",
          Key: expect.objectContaining({ sk: "#META" }),
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

  it("backfills explicit task short-code metadata from an active site code", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
    send.mockResolvedValueOnce({}); // enrollment-code lookup
    send.mockResolvedValueOnce({}); // dynamic setup-code lookup
    send.mockResolvedValueOnce({
      Item: {
        active: true,
        providerId: "the-gubbio-project",
        providerShortCode: "GUB",
        providerSiteId: "provider-site-1",
        siteId: "site-1",
        siteName: "St. John",
        siteShortCode: "STJ",
      },
    });
    send.mockResolvedValueOnce({ Item: { status: "active" } });
    send.mockResolvedValueOnce({});

    const res = await callHandler({ code: "GUB-SJE" });

    expect(res.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const command = send.mock.calls[4][0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toMatchObject({
      TableName: "gnp-test-app",
      Key: { pk: "SITE#site-1", sk: "#META" },
      ExpressionAttributeValues: expect.objectContaining({
        ":providerShortCode": "GUB",
        ":siteShortCode": "STJ",
      }),
    });
  });

  it("rejects inactive or unknown codes with a generic error", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
    send
      .mockResolvedValueOnce({}) // enrollment-code lookup
      .mockResolvedValueOnce({}) // dynamic setup-code lookup
      .mockResolvedValueOnce({ Item: { active: false } });

    const res = await callHandler({ code: "000000" });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_site_code" });
  });

  it("does not backfill short codes for an inactive site", async () => {
    vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
    vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
    send
      .mockResolvedValueOnce({}) // enrollment-code lookup
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Item: {
          active: true,
          providerSiteId: "provider-site-1",
          siteId: "site-1",
          siteName: "St. John",
          providerShortCode: "GUB",
          siteShortCode: "STJ",
        },
      })
      .mockResolvedValueOnce({ Item: { status: "inactive" } });

    const res = await callHandler({ code: "GUB-SJE" });

    expect(res.statusCode).toBe(401);
    expect(
      send.mock.calls.every(([command]) => command instanceof GetCommand),
    ).toBe(true);
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

it("stops throttled code guesses before any lookup", async () => {
  const limited = {
    statusCode: 429,
    body: JSON.stringify({ error: "code_attempts_limited" }),
  };
  vi.mocked(checkCodeAttemptLimit).mockResolvedValueOnce(limited);
  expect(await callHandler({ code: "a1b-2c3" })).toEqual(limited);
  expect(send).not.toHaveBeenCalled();
});
it("does not look up codes when the rate-limit store fails", async () => {
  const error = new Error("rate store unavailable");
  vi.mocked(checkCodeAttemptLimit).mockRejectedValueOnce(error);
  await expect(callHandler({ code: "a1b-2c3" })).rejects.toBe(error);
  expect(send).not.toHaveBeenCalled();
});
