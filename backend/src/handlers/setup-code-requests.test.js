import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { searchSites } = await import("./setup-code-requests.js");

beforeEach(() => {
  send.mockReset();
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

/**
 * @param {import("aws-lambda").APIGatewayProxyHandlerV2} handler
 * @param {any} evt
 * @returns {Promise<any>}
 */
function call(handler, evt) {
  return Promise.resolve(handler(evt, /** @type {any} */ ({}), () => {}));
}
