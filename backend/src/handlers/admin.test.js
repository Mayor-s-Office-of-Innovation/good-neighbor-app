import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  send,
  deleteObject,
  geocodeAddress,
  headObject,
  presignPut,
  setObjectTags,
} = vi.hoisted(() => ({
  send: vi.fn(),
  deleteObject: vi.fn(),
  geocodeAddress: vi.fn(),
  headObject: vi.fn(),
  presignPut: vi.fn(),
  setObjectTags: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
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
vi.mock("../s3.js", () => ({
  deleteObject,
  headObject,
  presignPut,
  setObjectTags,
}));

const {
  createMasterContact,
  createProvider,
  createSite,
  deactivateProvider,
  deactivateSite,
  deactivateMasterContact,
  issueAdminSetupCode,
  listProviders,
  presignComplianceLetter,
  revokeDevice,
  updateSite,
} = await import("./admin.js");

beforeEach(() => {
  send.mockReset();
  deleteObject.mockReset();
  geocodeAddress.mockReset();
  headObject.mockReset();
  presignPut.mockReset();
  setObjectTags.mockReset();
  geocodeAddress.mockResolvedValue({
    latitude: 37.7793,
    longitude: -122.4192,
    matchedAddress: "1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102",
  });
  headObject.mockResolvedValue({
    contentType: "application/pdf",
    contentLength: 1024,
  });
  setObjectTags.mockResolvedValue({});
  deleteObject.mockResolvedValue({});
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("S3_UPLOAD_BUCKET", "gnp-test-uploads");
  vi.stubEnv("SQS_QUEUE_URL", "https://sqs.example/queue");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
});

describe("admin authorization", () => {
  it.each([
    "central-admin",
    "[central-admin]",
    "[support, central-admin]",
    '["support","central-admin"]',
    ["support", "central-admin"],
  ])(
    "accepts exact membership in supported claim format %j",
    async (groups) => {
      send.mockResolvedValue({ Items: [] });
      const res = await call(listProviders, event(undefined, groups));
      expect(res.statusCode).toBe(200);
    },
  );

  it.each([
    "",
    "not-central-admin",
    "[not-central-admin]",
    "[central-admin-readonly]",
    "[support central-admin]",
    "[central-admin",
    '["central-admin-readonly"]',
    { role: "central-admin" },
    ["not-central-admin"],
    null,
  ])(
    "rejects missing, malformed, or nonmatching membership %j",
    async (groups) => {
      const res = await call(listProviders, event(undefined, groups));
      expect(res.statusCode).toBe(403);
      expect(send).not.toHaveBeenCalled();
    },
  );

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
      event(
        {
          name: "Main Site",
          address: "1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102",
        },
        "central-admin",
        {
          providerId: "provider-one",
        },
      ),
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
    // Sites no longer carry a places list (docs/plan-remove-places.md).
    expect(tx.input.TransactItems?.[0]?.Put?.Item).not.toHaveProperty("places");
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
      address: "1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102",
      location: { latitude: 37.7793, longitude: -122.4192 },
    });
  });

  it("rejects unknown providers before geocoding the site address", async () => {
    send.mockResolvedValueOnce({});

    const res = await call(
      createSite,
      event(
        { name: "Main Site", address: "1 Dr Carlton B Goodlett Pl" },
        "central-admin",
        { providerId: "missing-provider" },
      ),
    );

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "provider_not_found" });
    expect(geocodeAddress).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
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
        event(
          { name: "Main Site", address: "1 Dr Carlton B Goodlett Pl" },
          "central-admin",
          {
            providerId: "provider-one",
          },
        ),
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

  it("archives a provider without changing its sites or access", async () => {
    send
      .mockResolvedValueOnce({
        Attributes: {
          providerId: "provider-one",
          status: "inactive",
        },
      })
      .mockResolvedValueOnce({});

    const res = await call(
      deactivateProvider,
      event(undefined, "central-admin", { providerId: "provider-one" }),
    );

    expect(res.statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.some(([cmd]) => cmd instanceof QueryCommand)).toBe(
      false,
    );
    expect(
      send.mock.calls.some(([cmd]) => cmd instanceof TransactWriteCommand),
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
          address: "1 Dr Carlton B Goodlett Pl",
          location: { latitude: 37.7793, longitude: -122.4192 },
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

  it("also deactivates provider membership when deactivating a provider site", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          providerId: "provider-one",
          status: "active",
        },
      })
      .mockResolvedValue({ Items: [] });

    const res = await call(
      deactivateSite,
      event(undefined, "central-admin", { siteId: "site-1" }),
    );

    expect(res.statusCode).toBe(200);
    const transaction = /** @type {TransactWriteCommand} */ (
      send.mock.calls[1][0]
    );
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: { pk: "PROVIDER#provider-one", sk: "SITE#site-1" },
            ExpressionAttributeValues: expect.objectContaining({
              ":inactive": "inactive",
            }),
          }),
        }),
      ]),
    );
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
      event(
        { name: "Civic Center", address: "1 Dr Carlton B Goodlett Pl" },
        "central-admin",
        { siteId: "site-1" },
      ),
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
      address: "1 Dr Carlton B Goodlett Pl",
    });
  });

  it("requires an address when creating a site", async () => {
    const res = await call(
      createSite,
      event({ name: "Main Site" }, "central-admin", {
        providerId: "provider-one",
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "address_required" });
    expect(send).not.toHaveBeenCalled();
  });

  it("geocodes an address added to an existing site", async () => {
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
      event(
        { name: "City Hall", address: "1 Dr Carlton B Goodlett Pl" },
        "central-admin",
        { siteId: "site-1" },
      ),
    );

    expect(res.statusCode).toBe(200);
    expect(geocodeAddress).toHaveBeenCalledWith("1 Dr Carlton B Goodlett Pl");
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx.input.TransactItems?.[0]).toMatchObject({
      Update: {
        ExpressionAttributeValues: {
          ":address": "1 Dr Carlton B Goodlett Pl",
          ":location": { latitude: 37.7793, longitude: -122.4192 },
        },
      },
    });
  });

  it("updates a legacy site's name without requiring newly introduced sections", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Legacy Site",
          status: "active",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({});

    const res = await call(
      updateSite,
      event({ name: "Renamed Legacy Site" }, "central-admin", {
        siteId: "site-1",
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(geocodeAddress).not.toHaveBeenCalled();
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx.input.TransactItems?.[0]?.Update?.UpdateExpression).toBe(
      "SET #name = :name, updatedAt = :now",
    );
    expect(
      tx.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues,
    ).not.toHaveProperty(":contactPerson");
    expect(
      tx.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues,
    ).not.toHaveProperty(":compliance");
  });

  it("updates all site information fields and supersedes the current letter", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Old Site",
          address: "1 Old St",
          providerId: "provider-one",
          status: "active",
          complianceLetters: {
            current: {
              effectiveStart: "2026-01-01",
              url: "/old-letter.pdf",
            },
            past: [],
          },
        },
      })
      .mockResolvedValueOnce({});

    const res = await call(
      updateSite,
      event(
        {
          name: "Updated Site",
          addressParts: {
            streetNumber: "1661",
            streetAddress: "15th St",
            secondLine: "Suite 2",
            city: "San Francisco",
            state: "CA",
            zip: "94103",
          },
          contactPerson: {
            firstName: "Priya",
            lastName: "Anand",
            email: "PRIYA@EXAMPLE.ORG",
            phone: "(415) 555-0148",
          },
          oversight: {
            managingCityDepartment: "DPH",
            managingSystemOfCare: "BHS-PBH",
            cityProgramManagerFirstName: "Rob",
            cityProgramManagerLastName: "Hoffman",
          },
          compliance: {
            currentTier: 2,
            periodStart: "2026-01-15",
            periodEnd: "",
            requiredChecksPerDay: 3,
          },
          perimeter: "Around the full block.",
          complianceLetter: {
            s3Key: "compliance-letters/site-1/new.pdf",
            fileName: "new.pdf",
            effectiveStart: "2026-02-01",
          },
        },
        "central-admin",
        { siteId: "site-1" },
      ),
    );

    expect(res.statusCode).toBe(200);
    expect(headObject).toHaveBeenCalledWith({
      bucket: "gnp-test-uploads",
      key: "compliance-letters/site-1/new.pdf",
    });
    expect(setObjectTags).toHaveBeenCalledWith({
      bucket: "gnp-test-uploads",
      key: "compliance-letters/site-1/new.pdf",
      tags: { state: "active" },
    });
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(
      tx.input.TransactItems?.[0]?.Update?.ExpressionAttributeValues,
    ).toMatchObject({
      ":address": "1661 15th St, Suite 2, San Francisco, CA 94103",
      ":contactPerson": {
        firstName: "Priya",
        lastName: "Anand",
        email: "priya@example.org",
        phone: "415-555-0148",
      },
      ":oversight": {
        managingCityDepartment: "DPH",
        managingSystemOfCare: "BHS-PBH",
        cityProgramManager: "Rob Hoffman",
      },
      ":compliance": {
        currentTier: 2,
        periodStart: "2026-01-15",
        periodEnd: "",
        requiredChecksPerDay: 3,
      },
      ":perimeter": "Around the full block.",
      ":complianceLetters": {
        current: {
          s3Key: "compliance-letters/site-1/new.pdf",
          fileName: "new.pdf",
          effectiveStart: "2026-02-01",
        },
        past: [
          {
            effectiveStart: "2026-01-01",
            effectiveEnd: "2026-01-31",
            url: "/old-letter.pdf",
          },
        ],
      },
    });
  });

  it("rejects and deletes a compliance letter whose stored size exceeds the limit", async () => {
    send.mockResolvedValueOnce({
      Item: {
        siteId: "site-1",
        name: "City Hall",
        address: "1 Main St",
        location: { latitude: 37.7, longitude: -122.4 },
        status: "active",
      },
    });
    headObject.mockResolvedValueOnce({
      contentType: "application/pdf",
      contentLength: 10 * 1024 * 1024 + 1,
    });

    const res = await call(
      updateSite,
      event(
        {
          name: "City Hall",
          complianceLetter: {
            s3Key: "compliance-letters/site-1/too-large.pdf",
            fileName: "too-large.pdf",
            effectiveStart: "2026-02-01",
          },
        },
        "central-admin",
        { siteId: "site-1" },
      ),
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_compliance_letter");
    expect(deleteObject).toHaveBeenCalledWith({
      bucket: "gnp-test-uploads",
      key: "compliance-letters/site-1/too-large.pdf",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict and removes the upload when the site changed concurrently", async () => {
    const conflict = new Error("site changed");
    conflict.name = "TransactionCanceledException";
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "City Hall",
          address: "1 Main St",
          location: { latitude: 37.7, longitude: -122.4 },
          status: "active",
          updatedAt: "2026-01-01T00:00:00.000Z",
          complianceLetters: { current: null, past: [] },
        },
      })
      .mockRejectedValueOnce(conflict);

    const res = await call(
      updateSite,
      event(
        {
          name: "City Hall",
          complianceLetter: {
            s3Key: "compliance-letters/site-1/concurrent.pdf",
            fileName: "concurrent.pdf",
            effectiveStart: "2026-02-01",
          },
        },
        "central-admin",
        { siteId: "site-1" },
      ),
    );

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("site_update_conflict");
    const tx = /** @type {TransactWriteCommand} */ (send.mock.calls[1][0]);
    expect(tx.input.TransactItems?.[0]?.Update?.ConditionExpression).toContain(
      "updatedAt = :expectedUpdatedAt",
    );
    expect(deleteObject).toHaveBeenCalledWith({
      bucket: "gnp-test-uploads",
      key: "compliance-letters/site-1/concurrent.pdf",
    });
  });

  it("presigns only a site-scoped PDF compliance letter upload", async () => {
    send.mockResolvedValueOnce({
      Item: { siteId: "site-1", status: "active" },
    });
    presignPut.mockResolvedValueOnce("https://uploads.example/signed");

    const res = await call(
      presignComplianceLetter,
      event(
        {
          contentType: "application/pdf",
          size: 1024,
          fileName: "letter.pdf",
        },
        "central-admin",
        { siteId: "site-1" },
      ),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.s3Key).toMatch(/^compliance-letters\/site-1\/[0-9a-f-]+\.pdf$/);
    expect(presignPut).toHaveBeenCalledWith({
      bucket: "gnp-test-uploads",
      key: body.s3Key,
      contentType: "application/pdf",
      tagging: "state=pending",
      expiresIn: 300,
    });
  });
});

/**
 * @param {unknown} [body]
 * @param {unknown} [groups]
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
