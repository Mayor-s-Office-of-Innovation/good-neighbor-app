import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, geocodeAddress } = vi.hoisted(() => ({
  send: vi.fn(),
  geocodeAddress: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/census-geocoder.js", () => ({
  GeocodingError: class GeocodingError extends Error {
    /** @param {string} code */ constructor(code) {
      super(code);
      this.code = code;
    }
  },
  geocodeAddress,
}));

const { applySiteImport, getSiteImportConflicts, previewSiteImport } =
  await import("./admin-site-imports.js");

const headers = [
  "Provider",
  "Program",
  "Site name",
  "Site address",
  "Site type",
  "Department",
  "Site manager first name",
  "Site manager last name",
  "Site manager phone",
  "Site manager extension",
  "Site manager email",
  "Program manager first name",
  "Program manager last name",
  "Program manager phone",
  "Program manager extension",
  "Program manager department",
  "Program manager email",
  "Provider manager first name",
  "Provider manager last name",
  "Provider manager phone",
  "Provider manager extension",
  "Provider manager email",
];
const baseValues = [
  "Provider One",
  "Program One",
  "Main Site",
  "1 Main St San Francisco CA 94102",
  "Shelter",
  "Department of Public Health (DPH)",
  "Sam",
  "Lee",
  "415-555-0100",
  "123",
  "sam@example.org",
  "Pat",
  "Manager",
  "415-555-0110",
  "",
  "Department of Public Health (DPH)",
  "pat.manager@sfgov.org",
  "Priya",
  "Provider",
  "415-555-0120",
  "",
  "priya@provider.org",
];

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ Items: [] });
  geocodeAddress.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-verifier-secret");
});

describe("Site CSV import", () => {
  it("requires the revised headers and previews all relationships", async () => {
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: makeCsv([baseValues]) }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body.counts).toEqual({
      create: 0,
      reuse: 0,
      acceptable: 1,
      conflict: 0,
      invalid: 0,
    });
    expect(body.rows[0].source).toMatchObject({
      "Site type": "Shelter",
      "Program manager email": "pat.manager@sfgov.org",
      "Provider manager email": "priya@provider.org",
    });
    expect(send.mock.calls.at(-1)?.[0]).toBeInstanceOf(BatchWriteCommand);
  });

  it("rejects the old Contact headers", async () => {
    const oldCsv = [
      "Provider,Program,Site name,Site address,Contact first name,Contact last name,Contact phone,Contact extension,Contact email",
      "Provider One,Program One,Main Site,1 Main St,Sam,Lee,,,sam@example.org",
    ].join("\n");
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: oldCsv }),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body)).error).toBe("invalid_headers");
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts repeated Site rows and accumulates different managers", async () => {
    const second = [...baseValues];
    second[6] = "Taylor";
    second[7] = "Jones";
    second[10] = "taylor@example.org";
    second[11] = "Alex";
    second[16] = "alex.manager@sfgov.org";
    second[17] = "Quinn";
    second[21] = "quinn@provider.org";
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: makeCsv([baseValues, second]) }),
    );
    const body = JSON.parse(String(response.body));
    expect(response.statusCode).toBe(201);
    expect(body.rows).toHaveLength(2);
    expect(body.counts.conflict).toBe(0);
  });

  it("marks unknown departments for manual resolution", async () => {
    const row = [...baseValues];
    row[5] = "DHP";
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: makeCsv([row]) }),
    );
    expect(JSON.parse(String(response.body)).rows[0]).toMatchObject({
      classification: "conflict",
      reasonCode: "unknown_department",
      existingValue: "DHP",
    });
  });

  it("requires Program manager phone while allowing other phone and extension blanks", async () => {
    const optionalBlank = [...baseValues];
    for (const index of [8, 9, 14, 19, 20]) optionalBlank[index] = "";
    const invalid = [...optionalBlank];
    invalid[16] = "";
    const missingProgramManagerPhone = [...optionalBlank];
    missingProgramManagerPhone[13] = "";
    const response = await call(
      previewSiteImport,
      event({
        fileName: "sites.csv",
        csv: makeCsv([optionalBlank, invalid, missingProgramManagerPhone]),
      }),
    );
    const body = JSON.parse(String(response.body));
    expect(body.rows[0]).toMatchObject({
      classification: "acceptable",
      reasonCode: "missing_optional_value",
    });
    expect(body.rows[1]).toMatchObject({
      classification: "invalid",
      reasonCode: "missing_required_value",
      existingValue: "Program manager email",
    });
    expect(body.rows[2]).toMatchObject({
      classification: "invalid",
      existingValue: "Program manager phone",
    });
  });

  it("requires manual resolution when an imported manager conflicts by email", async () => {
    send.mockImplementation(async (command) => {
      if (
        command instanceof QueryCommand &&
        command.input.ExpressionAttributeValues?.[":pk"] ===
          "ADMIN_DIRECTORY#PROGRAM_MANAGERS"
      ) {
        return {
          Items: [
            {
              userId: "manager-1",
              email: "pat.manager@sfgov.org",
              firstName: "Different",
              lastName: "Person",
            },
          ],
        };
      }
      return { Items: [] };
    });
    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: makeCsv([baseValues]) }),
    );
    expect(JSON.parse(String(response.body)).rows[0]).toMatchObject({
      classification: "conflict",
      reasonCode: "program_manager_exact_match_conflict",
    });
  });

  it("applies Site, Compliance-manager, and Provider-manager relationships atomically", async () => {
    const row = importRow();
    let rowQueryCount = 0;
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand)
        return {
          Item: {
            previewVersion: "preview-1",
            previewExpiresAt: "2099-01-01T00:00:00.000Z",
            counts: { create: 1 },
            fileName: "sites.csv",
          },
        };
      if (command instanceof QueryCommand) {
        rowQueryCount += 1;
        return {
          Items: rowQueryCount === 1 ? [row] : [{ ...row, outcome: "applied" }],
        };
      }
      return {};
    });
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
    const transaction = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof TransactWriteCommand);
    if (!(transaction instanceof TransactWriteCommand)) {
      throw new Error("Expected an import transaction");
    }
    const items = transaction.input.TransactItems;
    if (!items) throw new Error("Expected transaction items");
    expect(
      items.some(
        (item) => item.Put?.Item?.type === "siteComplianceManagerAssignment",
      ),
    ).toBe(true);
    expect(
      items.some(
        (item) => item.Put?.Item?.type === "providerManagerMembership",
      ),
    ).toBe(true);
    const site = items.find((item) => item.Put?.Item?.type === "site")?.Put
      ?.Item;
    if (!site) throw new Error("Expected a Site item");
    expect(site).toMatchObject({
      siteType: "shelter",
      oversight: {
        managingCityDepartment: "Department of Public Health (DPH)",
      },
    });
    expect(site.primaryContactUserId).toBeUndefined();
  });

  it("escapes spreadsheet formula prefixes in conflict downloads", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          rowNumber: 2,
          classification: "conflict",
          reasonCode: "site_exact_match_conflict",
          source: Object.fromEntries(
            headers.map((header, index) => [
              header,
              index === 0 ? "=CMD()" : baseValues[index],
            ]),
          ),
        },
      ],
    });
    const response = await call(
      getSiteImportConflicts,
      event(undefined, { importId: "import-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(String(response.body)).toContain("'=CMD()");
  });
});

/** @param {string[][]} rows */
function makeCsv(rows) {
  return [headers, ...rows].map((row) => row.join(",")).join("\n");
}

function importRow() {
  const department = {
    id: "dph",
    name: "Department of Public Health (DPH)",
    action: "create",
  };
  return {
    pk: "SITE_IMPORT#import-1",
    sk: "ROW#000002",
    rowNumber: 2,
    classification: "create",
    source: Object.fromEntries(
      headers.map((header, index) => [header, baseValues[index]]),
    ),
    plan: {
      provider: { id: "provider-one", action: "create", name: "Provider One" },
      program: {
        id: "provider-one-program-one",
        action: "create",
        name: "Program One",
      },
      site: {
        id: "main-site",
        action: "create",
        name: "Main Site",
        address: "1 Main St San Francisco CA 94102",
        siteType: "shelter",
        department,
      },
      contact: { id: "contact-1", action: "create", email: "sam@example.org" },
      assignment: { action: "create" },
      manager: { id: "membership-1", action: "create" },
      complianceManager: {
        id: "manager-1",
        action: "create",
        email: "pat.manager@sfgov.org",
        department,
      },
      complianceAssignment: { action: "create" },
      providerManager: {
        id: "provider-manager-1",
        action: "create",
        email: "priya@provider.org",
      },
      departments: [department],
    },
  };
}

/** @param {unknown} body @param {Record<string, string>} pathParameters */
function event(body = undefined, pathParameters = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: { "cognito:groups": "compliance-supervisor", sub: "admin-1" },
        },
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
