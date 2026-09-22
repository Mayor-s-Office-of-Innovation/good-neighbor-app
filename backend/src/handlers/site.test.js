import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { listProviderSites } = await import("./site.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("S3_UPLOAD_BUCKET", "test-bucket");
  vi.stubEnv("SQS_QUEUE_URL", "test-queue");
});

/**
 * @param {string} siteId
 * @returns {any}
 */
function event(siteId) {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: { jwt: { claims: { "custom:siteId": siteId } } },
    },
  });
}

/**
 * @param {any} response
 * @returns {any}
 */
function body(response) {
  return JSON.parse(response.body);
}

describe("listProviderSites", () => {
  it("derives the provider from the authenticated site and excludes inactive memberships", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          providerId: "provider-1",
          providerName: "Provider One",
        },
      })
      .mockResolvedValueOnce({
        Items: [
          { siteId: "site-2", siteName: "Second", status: "active" },
          { siteId: "site-1", siteName: "First", status: "active" },
          { siteId: "site-3", siteName: "Inactive", status: "inactive" },
        ],
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-2", providerId: "provider-1", name: "Second" },
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", providerId: "provider-1", name: "First" },
      });

    const response = await /** @type {any} */ (listProviderSites)(
      event("site-1"),
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[0][0].input.Key).toEqual({
      pk: "SITE#site-1",
      sk: "#META",
    });
    expect(send.mock.calls[1][0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[1][0].input.ExpressionAttributeValues).toEqual({
      ":pk": "PROVIDER#provider-1",
      ":prefix": "SITE#",
    });
    expect(body(response)).toEqual({
      providerId: "provider-1",
      providerName: "Provider One",
      sites: [
        { siteId: "site-1", name: "First" },
        { siteId: "site-2", name: "Second" },
      ],
    });
  });

  it("excludes a site whose metadata is inactive despite an active membership", async () => {
    send
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", providerId: "provider-1" },
      })
      .mockResolvedValueOnce({
        Items: [
          { siteId: "site-1", siteName: "First", status: "active" },
          { siteId: "site-2", siteName: "Closed", status: "active" },
        ],
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", providerId: "provider-1", name: "First" },
      })
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-2",
          providerId: "provider-1",
          name: "Closed",
          status: "inactive",
        },
      });

    const response = await /** @type {any} */ (listProviderSites)(
      event("site-1"),
    );

    expect(body(response).sites).toEqual([{ siteId: "site-1", name: "First" }]);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("does not enumerate sites when the current site has no provider", async () => {
    send.mockResolvedValueOnce({ Item: { name: "Standalone" } });

    const response = await /** @type {any} */ (listProviderSites)(
      event("site-1"),
    );

    expect(body(response).sites).toEqual([
      { siteId: "site-1", name: "Standalone" },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
