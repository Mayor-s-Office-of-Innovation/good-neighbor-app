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

const { applySiteImport, getSiteImportConflicts, previewSiteImport } =
  await import("./admin-site-imports.js");

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
    const duplicate = `${csv}\nProvider Two,Program One,Main Site,2 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,sam@example.org`;
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
