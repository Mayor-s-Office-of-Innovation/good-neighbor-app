import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, geocodeAddress, presignGet } = vi.hoisted(() => ({
  send: vi.fn(),
  geocodeAddress: vi.fn(),
  presignGet: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../s3.js", () => ({ presignGet }));
vi.mock("../integrations/census-geocoder.js", () => ({
  GeocodingError: class GeocodingError extends Error {
    /** @param {string} code */
    constructor(code) {
      super(code);
      this.code = code;
    }
  },
  geocodeAddress,
}));

const { getSite, getSiteAdmin, listProviderSites, updateSiteAdmin } =
  await import("./site.js");

beforeEach(() => {
  send.mockReset();
  geocodeAddress.mockReset();
  presignGet.mockReset();
  geocodeAddress.mockResolvedValue({
    latitude: 37.75,
    longitude: -122.42,
    matchedAddress: "2 NEW ST, SAN FRANCISCO, CA 94103",
  });
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
 * @param {string} siteId
 * @param {"general"|"admin"} accessLevel
 * @returns {any}
 */
function accessEvent(siteId, accessLevel) {
  return /** @type {any} */ ({
    requestContext: {
      authorizer: {
        jwt: { claims: { "custom:siteId": siteId, accessLevel } },
      },
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
    expect(send.mock.calls[1][0].input.Limit).toBe(25);
    expect(body(response)).toEqual({
      providerId: "provider-1",
      providerName: "Provider One",
      sites: [
        { siteId: "site-1", name: "First" },
        { siteId: "site-2", name: "Second" },
      ],
      nextCursor: null,
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

  it("returns a cursor and reads only one bounded membership page", async () => {
    const lastKey = { pk: "PROVIDER#provider-1", sk: "SITE#site-25" };
    send
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", providerId: "provider-1" },
      })
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", status: "active" }],
        LastEvaluatedKey: lastKey,
      })
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", providerId: "provider-1", name: "First" },
      });

    const first = await /** @type {any} */ (listProviderSites)(event("site-1"));
    const cursor = body(first).nextCursor;
    expect(cursor).toBe(Buffer.from("SITE#site-25").toString("base64url"));
    expect(send).toHaveBeenCalledTimes(3);

    send.mockReset();
    send
      .mockResolvedValueOnce({
        Item: { siteId: "site-1", providerId: "provider-1" },
      })
      .mockResolvedValueOnce({ Items: [] });
    const nextEvent = event("site-1");
    nextEvent.queryStringParameters = { cursor };
    const second = await /** @type {any} */ (listProviderSites)(nextEvent);
    expect(body(second).nextCursor).toBeNull();
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual(lastKey);
  });

  it("rejects a malformed cursor without querying memberships", async () => {
    send.mockResolvedValueOnce({
      Item: { siteId: "site-1", providerId: "provider-1" },
    });
    const request = event("site-1");
    request.queryStringParameters = { cursor: "invalid!" };

    const response = await /** @type {any} */ (listProviderSites)(request);
    expect(response.statusCode).toBe(400);
    expect(body(response)).toEqual({ error: "invalid_cursor" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent site metadata reads to five", async () => {
    let inFlight = 0;
    let peak = 0;
    let currentSiteRead = true;
    send.mockImplementation(async (command) => {
      if (currentSiteRead) {
        currentSiteRead = false;
        return { Item: { siteId: "site-1", providerId: "provider-1" } };
      }
      if (command instanceof QueryCommand) {
        return {
          Items: Array.from({ length: 12 }, (_, index) => ({
            siteId: `site-${index + 1}`,
            status: "active",
          })),
        };
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return {
        Item: {
          siteId: command.input.Key.pk.replace("SITE#", ""),
          providerId: "provider-1",
          name: "Site",
        },
      };
    });

    const response = await /** @type {any} */ (listProviderSites)(
      event("site-1"),
    );
    expect(body(response).sites).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("site admin", () => {
  it("keeps admin-only fields out of the general site response", async () => {
    send.mockResolvedValueOnce({
      Item: {
        siteId: "site-1",
        name: "Mission",
        contactPerson: { email: "private@example.org" },
        oversight: { managingCityDepartment: "DPH" },
        complianceLetters: { current: { url: "/letter.pdf" } },
      },
    });
    const response = await /** @type {any} */ (getSite)(event("site-1"));
    expect(body(response).site).toEqual({ siteId: "site-1", name: "Mission" });
  });

  it("denies general-access devices without reading site data", async () => {
    const response = await /** @type {any} */ (getSiteAdmin)(
      accessEvent("site-1", "general"),
    );
    expect(response.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the admin information to an admin-access device", async () => {
    send.mockResolvedValueOnce({
      Item: {
        siteId: "site-1",
        name: "Mission",
        addressParts: { streetNumber: "1", streetAddress: "Main St" },
        contactPerson: { firstName: "Priya", lastName: "Anand" },
        perimeter: "The block",
      },
    });
    const response = await /** @type {any} */ (getSiteAdmin)(
      accessEvent("site-1", "admin"),
    );
    expect(response.statusCode).toBe(200);
    expect(body(response).site).toMatchObject({
      siteId: "site-1",
      name: "Mission",
      perimeter: "The block",
    });
  });

  it("returns a fresh download URL for an uploaded compliance letter", async () => {
    send.mockResolvedValueOnce({
      Item: {
        siteId: "site-1",
        name: "Mission",
        complianceLetters: {
          current: {
            s3Key: "compliance-letters/site-1/current.pdf",
            fileName: "current.pdf",
            effectiveStart: "2026-02-01",
          },
          past: [],
        },
      },
    });
    presignGet.mockResolvedValueOnce("https://uploads.example/current");

    const response = await /** @type {any} */ (getSiteAdmin)(
      accessEvent("site-1", "admin"),
    );

    expect(body(response).site.complianceLetters.current.url).toBe(
      "https://uploads.example/current",
    );
    expect(presignGet).toHaveBeenCalledWith({
      bucket: "test-bucket",
      key: "compliance-letters/site-1/current.pdf",
      expiresIn: 300,
    });
  });

  it("validates and updates the contact person", async () => {
    send.mockResolvedValueOnce({
      Item: { siteId: "site-1", name: "Mission", status: "active" },
    });
    send.mockResolvedValueOnce({});
    const request = accessEvent("site-1", "admin");
    request.body = JSON.stringify({
      section: "contactPerson",
      values: {
        firstName: "Priya",
        lastName: "Anand",
        email: "priya@example.org",
        phone: "(415) 555-0148",
      },
    });
    const response = await /** @type {any} */ (updateSiteAdmin)(request);
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(
      send.mock.calls[1][0].input.ExpressionAttributeValues[":contact"],
    ).toEqual({
      firstName: "Priya",
      lastName: "Anand",
      email: "priya@example.org",
      phone: "(415) 555-0148",
    });
  });

  it("atomically reindexes and geocodes edited site details", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Old Name",
          address: "1 Old St, San Francisco, CA 94103",
          providerId: "provider-1",
          providerName: "Provider One",
          providerSiteId: "provider-site-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({});
    const request = accessEvent("site-1", "admin");
    request.body = JSON.stringify({
      section: "siteDetails",
      values: {
        name: "New Name",
        address: {
          streetNumber: "2",
          streetAddress: "New St",
          secondLine: "",
          city: "San Francisco",
          state: "CA",
          zip: "94103",
        },
      },
    });

    const response = await /** @type {any} */ (updateSiteAdmin)(request);

    expect(response.statusCode).toBe(200);
    expect(geocodeAddress).toHaveBeenCalledWith(
      "2 New St, San Francisco, CA 94103",
    );
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx).toBeInstanceOf(TransactWriteCommand);
    expect(tx.input.TransactItems?.[0]?.Update).toMatchObject({
      Key: { pk: "SITE#site-1", sk: "#META" },
      ExpressionAttributeValues: {
        ":name": "New Name",
        ":location": { latitude: 37.75, longitude: -122.42 },
        ":geocodedAddress": "2 NEW ST, SAN FRANCISCO, CA 94103",
      },
    });
    expect(tx.input.TransactItems?.[1]?.Update?.Key).toEqual({
      pk: "PROVIDER#provider-1",
      sk: "SITE#site-1",
    });
    expect(tx.input.TransactItems?.[2]?.Delete?.Key).toEqual({
      pk: "SITE_SEARCH#ACTIVE",
      sk: "old name#site-1",
    });
    expect(tx.input.TransactItems?.[3]?.Put?.Item).toMatchObject({
      pk: "SITE_SEARCH#ACTIVE",
      sk: "new name#site-1",
      siteName: "New Name",
      searchText: "new name provider one",
    });
  });
});
