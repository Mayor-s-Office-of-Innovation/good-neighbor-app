import {
  BatchWriteCommand,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, geocodeAddress } = vi.hoisted(() => ({
  send: vi.fn(),
  geocodeAddress: vi.fn(),
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

const {
  applySiteImport,
  getSiteImport,
  getSiteImportConflicts,
  previewSiteImport,
} = await import("./admin-site-imports.js");

const csv = [
  "Provider,Program,Site name,Site address,Contact first name,Contact last name,Contact phone,Contact email",
  "Provider One,Program One,Main Site,1 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,sam@example.org",
].join("\n");

beforeEach(() => {
  send.mockReset();
  geocodeAddress.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("Site CSV import", () => {
  it("previews valid rows without applying master-data writes", async () => {
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv }),
    );
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(response.body)).counts).toEqual({
      create: 1,
      reuse: 0,
      conflict: 0,
      invalid: 0,
    });
    expect(send.mock.calls[3][0]).toBeInstanceOf(BatchWriteCommand);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });

  it("blocks structurally contradictory duplicate Site rows", async () => {
    const duplicate = `${csv}\nProvider Two,Program One,Main Site,1 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,sam@example.org`;
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: duplicate }),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body)).error).toBe(
      "contradictory_duplicate_rows",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("allows the same Site name at different addresses", async () => {
    const twoAddresses = `${csv}\nProvider One,Program One,Main Site,2 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,sam@example.org`;
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: twoAddresses }),
    );

    expect(response.statusCode).toBe(201);
    expect(JSON.parse(String(response.body)).counts.create).toBe(2);
  });

  it("reads every catalog query page before planning", async () => {
    send
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { pk: "next" } })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv }),
    );

    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[3][0].input.ExclusiveStartKey).toEqual({
      pk: "next",
    });
  });

  it("reads every Program-contact page before classifying a row", async () => {
    send
      .mockResolvedValueOnce({
        Items: [{ providerId: "provider-one", name: "Provider One" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            programId: "program-one",
            providerId: "provider-one",
            name: "Program One",
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Items: [],
        LastEvaluatedKey: { pk: "PROGRAM#program-one", sk: "USER#page-2" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            programId: "program-one",
            userId: "contact-1",
            firstName: "Different",
            lastName: "Person",
            phone: "415-555-9999",
            email: "sam@example.org",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv }),
    );

    const body = JSON.parse(String(response.body));
    expect(body.counts.conflict).toBe(1);
    expect(body.rows[0].reasonCode).toBe("contact_exact_match_conflict");
    expect(send.mock.calls[4][0].input.ExclusiveStartKey).toEqual({
      pk: "PROGRAM#program-one",
      sk: "USER#page-2",
    });
  });

  it("reads every stored row page when reopening an import", async () => {
    send
      .mockResolvedValueOnce({ Item: { importId: "import-1" } })
      .mockResolvedValueOnce({
        Items: [{ ...importRow(), rowNumber: 2 }],
        LastEvaluatedKey: { pk: "SITE_IMPORT#import-1", sk: "ROW#000002" },
      })
      .mockResolvedValueOnce({ Items: [{ ...importRow(), rowNumber: 3 }] });

    const response = await call(
      getSiteImport,
      event(undefined, { importId: "import-1" }),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).rows).toHaveLength(2);
    expect(send.mock.calls[2][0].input.ExclusiveStartKey).toEqual({
      pk: "SITE_IMPORT#import-1",
      sk: "ROW#000002",
    });
  });

  it("conflicts when the same name-address Site belongs to another Provider", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          { providerId: "provider-one", name: "Provider One" },
          { providerId: "provider-two", name: "Provider Two" },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            programId: "program-one",
            providerId: "provider-one",
            name: "Program One",
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [{ siteId: "existing-site" }] })
      .mockResolvedValueOnce({
        Responses: {
          "gnp-test-app": [
            {
              siteId: "existing-site",
              providerId: "provider-two",
              leadProgramId: "other-program",
              name: "Main Site",
              address: "1 Main St San Francisco CA 94102",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv }),
    );

    const body = JSON.parse(String(response.body));
    expect(body.counts.conflict).toBe(1);
    expect(body.rows[0].reasonCode).toBe("site_exact_match_conflict");
  });

  it("applies one valid row as one master-data transaction", async () => {
    const row = importRow();
    send
      .mockResolvedValueOnce({
        Item: {
          previewVersion: "preview-1",
          previewExpiresAt: "2099-01-01T00:00:00.000Z",
          counts: { create: 1, reuse: 0, conflict: 0, invalid: 0 },
        },
      })
      .mockResolvedValueOnce({ Items: [row] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ ...row, outcome: "applied" }] })
      .mockResolvedValueOnce({});
    geocodeAddress.mockResolvedValueOnce({
      latitude: 37.78,
      longitude: -122.42,
      matchedAddress: "1 MAIN ST, SAN FRANCISCO, CA 94102",
    });
    const response = await call(
      applySiteImport,
      event(
        { previewVersion: "preview-1", idempotencyKey: "apply-1" },
        { importId: "import-1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(UpdateCommand);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(12);
  });

  it("escapes spreadsheet formula prefixes in conflict downloads", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          rowNumber: 2,
          classification: "conflict",
          reasonCode: "site_exact_match_conflict",
          source: {
            Provider: "=CMD()",
            Program: "Program",
            "Site name": "Site",
            "Site address": "Address",
            "Contact first name": "Sam",
            "Contact last name": "Lee",
            "Contact phone": "415-555-0100",
            "Contact email": "sam@example.org",
          },
        },
      ],
    });
    const response = await call(
      getSiteImportConflicts,
      event(undefined, { importId: "import-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers?.["content-type"]).toContain("text/csv");
    expect(String(response.body)).toContain("'=CMD()");
  });
});

function importRow() {
  return {
    pk: "SITE_IMPORT#import-1",
    sk: "ROW#000002",
    rowNumber: 2,
    classification: "create",
    source: {
      Provider: "Provider One",
      Program: "Program One",
      "Site name": "Main Site",
      "Site address": "1 Main St San Francisco CA 94102",
      "Contact first name": "Sam",
      "Contact last name": "Lee",
      "Contact phone": "415-555-0100",
      "Contact email": "sam@example.org",
    },
    plan: {
      provider: { id: "provider-one", action: "create" },
      program: { id: "provider-one-program-one", action: "create" },
      site: { id: "provider-one-main-site", action: "create" },
      contact: { id: "contact-1", action: "create" },
      assignment: { action: "create" },
    },
  };
}

/**
 * @param {unknown} body
 * @param {Record<string, string>} pathParameters
 */
function event(body = undefined, pathParameters = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": "central-admin", sub: "admin-1" } },
      },
    },
  };
}

/** @param {Function} handler @param {any} request */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, {}, () => {})
  );
}
