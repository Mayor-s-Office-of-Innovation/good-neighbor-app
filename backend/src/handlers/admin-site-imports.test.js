import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
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
  listSiteImports,
  previewSiteImport,
} = await import("./admin-site-imports.js");

const csv = [
  "Provider,Program,Site name,Site address,Contact first name,Contact last name,Contact phone,Contact extension,Contact email",
  "Provider One,Program One,Main Site,1 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,123,sam@example.org",
].join("\n");

beforeEach(() => {
  send.mockReset();
  geocodeAddress.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-verifier-secret");
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
      acceptable: 0,
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
    const duplicate = `${csv}\nProvider Two,Program One,Main Site,1 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,123,sam@example.org`;
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
    const twoAddresses = `${csv}\nProvider One,Program One,Main Site,2 Main St San Francisco CA 94102,Sam,Lee,415-555-0100,123,sam@example.org`;
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

  it("allows a blank Contact extension value", async () => {
    const withoutExtension = csv.replace(
      "415-555-0100,123,sam@example.org",
      "415-555-0100,,sam@example.org",
    );
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: withoutExtension }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body.counts.acceptable).toBe(1);
    expect(body.rows[0]).toMatchObject({
      classification: "acceptable",
      reasonCode: "missing_optional_value",
      existingValue: "Contact extension",
    });
  });

  it("allows a blank Contact phone value", async () => {
    const withoutPhone = csv.replace(
      "415-555-0100,123,sam@example.org",
      ",123,sam@example.org",
    );
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: withoutPhone }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(String(response.body));
    expect(body.counts.acceptable).toBe(1);
    expect(body.rows[0]).toMatchObject({
      classification: "acceptable",
      reasonCode: "missing_optional_value",
      existingValue: "Contact phone",
    });
  });

  it("marks a row missing both optional phone fields as acceptable", async () => {
    const withoutPhoneFields = csv.replace(
      "415-555-0100,123,sam@example.org",
      ",,sam@example.org",
    );
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: withoutPhoneFields }),
    );

    const body = JSON.parse(String(response.body));
    expect(body.counts.acceptable).toBe(1);
    expect(body.rows[0]).toMatchObject({
      classification: "acceptable",
      existingValue: "Contact phone, Contact extension",
    });
  });

  it("does not conflict when optional phone values are blank for an existing contact", async () => {
    const withoutPhoneFields = csv.replace(
      "415-555-0100,123,sam@example.org",
      ",,sam@example.org",
    );
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
        Items: [
          {
            programId: "program-one",
            userId: "contact-1",
            firstName: "Sam",
            lastName: "Lee",
            phone: "415-555-0100",
            phoneExtension: "123",
            email: "sam@example.org",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: withoutPhoneFields }),
    );

    const body = JSON.parse(String(response.body));
    expect(body.counts.acceptable).toBe(1);
    expect(body.counts.conflict).toBe(0);
  });

  it("marks a row missing a required field as invalid", async () => {
    const withoutEmail = csv.replace("sam@example.org", "");
    send
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      previewSiteImport,
      event({ fileName: "sites.csv", csv: withoutEmail }),
    );

    const body = JSON.parse(String(response.body));
    expect(body.counts.invalid).toBe(1);
    expect(body.rows[0]).toMatchObject({
      classification: "invalid",
      reasonCode: "missing_required_value",
      existingValue: "Contact email",
    });
  });

  it("reads every Program-contact page and conflicts on a different extension", async () => {
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
            firstName: "Sam",
            lastName: "Lee",
            phone: "415-555-0100",
            phoneExtension: "999",
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
          fileName: "sites.csv",
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
    expect(transaction.input.TransactItems).toHaveLength(15);
    const transactionItems = /** @type {any[]} */ (
      transaction.input.TransactItems
    );
    expect(transactionTargetKeys(transactionItems)).toHaveLength(
      new Set(transactionTargetKeys(transactionItems)).size,
    );
    const programUser = transactionItems.find(
      (item) => item.Put?.Item?.type === "programUser",
    ).Put.Item;
    expect(programUser.phoneExtension).toBe("123");
    expect(programUser.siteManager).toBe(true);
    expect(
      transactionItems.find(
        (item) => item.Put?.Item?.type === "managerMembership",
      )?.Put.Item,
    ).toMatchObject({
      siteId: "provider-one-main-site",
      programId: "provider-one-program-one",
      userId: "contact-1",
      name: "Sam Lee",
      email: "sam@example.org",
      status: "active",
    });
    const site = transactionItems.find(
      (item) => item.Put?.Item?.type === "site",
    ).Put.Item;
    expect(site.primaryContactUserId).toBe("contact-1");
    expect(site.primaryContact.phoneExtension).toBe("123");
    expect(
      transactionItems.some((item) =>
        item.Update?.UpdateExpression?.includes("primaryContact"),
      ),
    ).toBe(false);
    const historyWrite = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutCommand);
    if (!(historyWrite instanceof PutCommand)) {
      throw new Error("Expected a completed-import history write");
    }
    expect(historyWrite.input.Item).toMatchObject({
      pk: "SITE_IMPORT_HISTORY#admin-1",
      fileName: "sites.csv",
      recordsAdded: 1,
      recordsUpdated: 0,
      recordsFailed: 0,
      resultStatus: "succeeded",
    });
    expect(JSON.parse(String(response.body)).resultStatus).toBe("succeeded");
  });

  it("lists the current administrator's recent completed imports", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          importId: "import-1",
          fileName: "sites.csv",
          completedAt: "2026-10-05T20:00:00.000Z",
          recordsAdded: 3,
          recordsUpdated: 2,
        },
      ],
    });

    const response = await call(listSiteImports, event());

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).imports).toHaveLength(1);
    const query = send.mock.calls[0][0];
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input).toMatchObject({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: {
        ":pk": "SITE_IMPORT_HISTORY#admin-1",
      },
      ScanIndexForward: false,
      Limit: 25,
    });
  });

  it("combines reuse checks with updates when adding an assignment", async () => {
    const baseRow = importRow();
    const row = {
      ...baseRow,
      plan: {
        provider: { ...baseRow.plan.provider, action: "reuse" },
        program: { ...baseRow.plan.program, action: "reuse" },
        site: { ...baseRow.plan.site, action: "reuse" },
        contact: {
          ...baseRow.plan.contact,
          action: "reuse",
          email: "sam@example.org",
        },
        assignment: { action: "create" },
      },
    };
    send
      .mockResolvedValueOnce({
        Item: {
          previewVersion: "preview-1",
          previewExpiresAt: "2099-01-01T00:00:00.000Z",
          counts: { create: 1 },
        },
      })
      .mockResolvedValueOnce({ Items: [row] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ ...row, outcome: "applied" }] })
      .mockResolvedValueOnce({});

    const response = await call(
      applySiteImport,
      event(
        { previewVersion: "preview-1", idempotencyKey: "apply-1" },
        { importId: "import-1" },
      ),
    );

    expect(response.statusCode).toBe(200);
    const transactionItems = /** @type {any[]} */ (
      send.mock.calls[3][0].input.TransactItems
    );
    expect(transactionTargetKeys(transactionItems)).toHaveLength(
      new Set(transactionTargetKeys(transactionItems)).size,
    );
    const contactUpdate = transactionItems.find(
      (item) => item.Update?.Key?.sk === "USER#contact-1",
    );
    expect(contactUpdate.Update.ConditionExpression).toContain(
      "email = :email",
    );
    const siteUpdate = transactionItems.find(
      (item) => item.Update?.Key?.sk === "#META",
    );
    expect(siteUpdate.Update.ConditionExpression).toContain(
      "leadProgramId = :programId",
    );
  });

  it("repairs a prior imported contact into a Site manager on re-import", async () => {
    const baseRow = importRow();
    const row = {
      ...baseRow,
      plan: {
        provider: { ...baseRow.plan.provider, action: "reuse" },
        program: { ...baseRow.plan.program, action: "reuse" },
        site: { ...baseRow.plan.site, action: "reuse" },
        contact: {
          ...baseRow.plan.contact,
          action: "reuse",
          email: "sam@example.org",
          promote: true,
        },
        assignment: { action: "reuse" },
        manager: { id: "membership-1", action: "create" },
      },
    };
    send
      .mockResolvedValueOnce({
        Item: {
          previewVersion: "preview-1",
          previewExpiresAt: "2099-01-01T00:00:00.000Z",
          counts: { create: 1 },
        },
      })
      .mockResolvedValueOnce({ Items: [row] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Items: [{ ...row, outcome: "applied" }] })
      .mockResolvedValueOnce({});

    const response = await call(
      applySiteImport,
      event(
        { previewVersion: "preview-1", idempotencyKey: "apply-repair" },
        { importId: "import-1" },
      ),
    );

    expect(response.statusCode).toBe(200);
    const transactionItems = /** @type {any[]} */ (
      send.mock.calls[3][0].input.TransactItems
    );
    const contactUpdate = transactionItems.find(
      (item) => item.Update?.Key?.sk === "USER#contact-1",
    );
    expect(contactUpdate.Update.UpdateExpression).toContain(
      "siteManager = :true",
    );
    expect(contactUpdate.Update.UpdateExpression).not.toContain(
      "siteAssignmentCount",
    );
    expect(
      transactionItems.find(
        (item) => item.Put?.Item?.type === "managerMembership",
      )?.Put.Item,
    ).toMatchObject({
      membershipId: "membership-1",
      programId: "provider-one-program-one",
      userId: "contact-1",
      siteId: "provider-one-main-site",
    });
    expect(transactionTargetKeys(transactionItems)).toHaveLength(
      new Set(transactionTargetKeys(transactionItems)).size,
    );
  });

  it("reports invalid database transactions as permanent apply failures", async () => {
    const row = importRow();
    const validationError = new Error(
      "Transaction request cannot include multiple operations on one item",
    );
    validationError.name = "ValidationException";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    send
      .mockResolvedValueOnce({
        Item: {
          previewVersion: "preview-1",
          previewExpiresAt: "2099-01-01T00:00:00.000Z",
          counts: { create: 1 },
        },
      })
      .mockResolvedValueOnce({ Items: [row] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(validationError)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            ...row,
            outcome: "failed",
            reasonCode: "invalid_apply_transaction",
          },
        ],
      })
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
    expect(JSON.parse(String(response.body))).toMatchObject({
      status: "complete",
      resultStatus: "failed",
    });
    const outcomeWrite = send.mock.calls[4][0];
    expect(outcomeWrite).toBeInstanceOf(UpdateCommand);
    expect(outcomeWrite.input.ExpressionAttributeValues).toMatchObject({
      ":outcome": "failed",
      ":reason": "invalid_apply_transaction",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Site import row apply failed",
      expect.objectContaining({
        importId: "import-1",
        rowNumber: 2,
        errorName: "ValidationException",
        retryable: false,
      }),
    );
    const historyWrite = send.mock.calls
      .map(([command]) => command)
      .find((command) => command instanceof PutCommand);
    expect(historyWrite?.input.Item).toMatchObject({
      recordsAdded: 0,
      recordsUpdated: 0,
      recordsFailed: 1,
      resultStatus: "failed",
    });
    consoleError.mockRestore();
  });

  it("keeps service failures retryable and reports a specific reason", async () => {
    const row = importRow();
    const serviceError = new Error("Service unavailable");
    serviceError.name = "ServiceUnavailable";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    send
      .mockResolvedValueOnce({
        Item: {
          previewVersion: "preview-1",
          previewExpiresAt: "2099-01-01T00:00:00.000Z",
          counts: { create: 1 },
        },
      })
      .mockResolvedValueOnce({ Items: [row] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(serviceError)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Items: [
          {
            ...row,
            outcome: "retryable_failed",
            reasonCode: "retryable_apply_error",
          },
        ],
      })
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

    expect(response.statusCode).toBe(202);
    expect(send.mock.calls[4][0].input.ExpressionAttributeValues).toMatchObject(
      {
        ":outcome": "retryable_failed",
        ":reason": "retryable_apply_error",
      },
    );
    consoleError.mockRestore();
  });

  it("applies an acceptable row with a blank optional phone", async () => {
    const baseRow = importRow();
    const row = {
      ...baseRow,
      classification: "acceptable",
      reasonCode: "missing_optional_value",
      existingValue: "Contact phone",
      source: { ...baseRow.source, "Contact phone": "" },
    };
    send
      .mockResolvedValueOnce({
        Item: {
          previewVersion: "preview-1",
          previewExpiresAt: "2099-01-01T00:00:00.000Z",
          counts: {
            create: 0,
            reuse: 0,
            acceptable: 1,
            conflict: 0,
            invalid: 0,
          },
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
        { previewVersion: "preview-1", idempotencyKey: "apply-acceptable" },
        { importId: "import-1" },
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[3][0]).toBeInstanceOf(TransactWriteCommand);
    expect(JSON.parse(String(response.body)).outcomes.applied).toBe(1);
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
            "Contact extension": "123",
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
      "Contact extension": "123",
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

/** @param {any[]} transactionItems */
function transactionTargetKeys(transactionItems) {
  return transactionItems.map((item) => {
    const operation = item.Put || item.Update || item.ConditionCheck;
    const target = operation.Item || operation.Key;
    return `${target.pk}|${target.sk}`;
  });
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
