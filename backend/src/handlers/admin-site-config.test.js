import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  assignSiteUser,
  createSiteTerms,
  endSiteTerms,
  getSitePerimeter,
  listSiteTerms,
  putSitePerimeter,
  unassignSiteUser,
} = await import("./admin-site-config.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("effective-dated Site terms", () => {
  it("lists terms newest first", async () => {
    send.mockResolvedValueOnce({ Items: [{ termsVersionId: "v1" }] });
    const response = await call(
      listSiteTerms,
      event(undefined, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.ScanIndexForward).toBe(false);
  });

  it("creates terms, closes the prior open version, and queues a letter", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          address: "1 Main St, San Francisco, CA 94102",
          status: "active",
          latestComplianceTermsVersionId: "old",
          primaryContactUserId: "contact-1",
          primaryContact: { firstName: "Sam", lastName: "Lee" },
          oversight: {
            managingCityDepartment: "Department of Public Health",
            cityProgramManagerId: "manager-1",
          },
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "COMPLIANCE_TERMS#2026-01-01#old",
            effectiveStart: "2026-01-01",
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            userId: "manager-1",
            firstName: "Rob",
            lastName: "Hoffman",
            email: "rob.hoffman@sfgov.org",
            phone: "415-555-0100",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const response = await call(
      createSiteTerms,
      event(
        {
          reasons: ["2", "6"],
          correctiveActionTier: 2,
          requiredChecksPerDay: 3,
          effectiveStart: "2026-11-01",
          periodEnd: "2026-12-01",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(5);
    expect(transaction.input.TransactItems[0].Put.Item.effectiveStart).toBe(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    );
    expect(transaction.input.TransactItems[1].Update).toMatchObject({
      ConditionExpression:
        "attribute_exists(pk) AND latestComplianceTermsVersionId = :observedLatest",
      ExpressionAttributeValues: expect.objectContaining({
        ":observedLatest": "old",
      }),
    });
    expect(
      transaction.input.TransactItems.some(
        (/** @type {any} */ item) =>
          item.Put?.Item?.type === "complianceLetterGenerationJob",
      ),
    ).toBe(true);
    expect(
      transaction.input.TransactItems.some(
        (/** @type {any} */ item) => item.Put?.Item?.type === "siteAuditEvent",
      ),
    ).toBe(true);
  });

  it("rejects overlapping future terms", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          address: "1 Main St",
          status: "active",
          primaryContactUserId: "contact-1",
          primaryContact: { firstName: "Sam", lastName: "Lee" },
          oversight: {
            managingCityDepartment: "DPH",
            cityProgramManagerId: "manager-1",
          },
        },
      })
      .mockResolvedValueOnce({
        Items: [{ effectiveStart: "2027-01-01", status: "scheduled" }],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            userId: "manager-1",
            firstName: "Rob",
            lastName: "Hoffman",
            email: "rob@sfgov.org",
            phone: "415-555-0100",
          },
        ],
      });
    const response = await call(
      createSiteTerms,
      event(
        {
          reasons: ["2"],
          requiredChecksPerDay: 2,
          effectiveStart: "2026-11-01",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "terms_overlap",
    });
  });

  it("requires an expiry when any temporary reason is selected", async () => {
    const response = await call(
      createSiteTerms,
      event(
        {
          reasons: ["1", "2"],
          requiredChecksPerDay: 3,
          effectiveStart: "2026-11-01",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "expiry_required",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("allows a new period after an earlier period was closed the same day", async () => {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          address: "1 Main St",
          status: "active",
          primaryContactUserId: "contact-1",
          primaryContact: { firstName: "Sam", lastName: "Lee" },
          oversight: {
            managingCityDepartment: "DPH",
            cityProgramManagerId: "manager-1",
          },
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            effectiveStart: today,
            expiresOnExclusive: today,
            status: "expired",
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            userId: "manager-1",
            firstName: "Rob",
            lastName: "Hoffman",
            email: "rob@sfgov.org",
            phone: "415-555-0100",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      createSiteTerms,
      event({ reasons: ["2"], requiredChecksPerDay: 3 }, { siteId: "site-1" }),
    );

    expect(response.statusCode).toBe(201);
  });

  it("ends the active period and clears the current compliance projection", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "COMPLIANCE_TERMS#2020-01-01#v1",
            termsVersionId: "v1",
            effectiveStart: "2020-01-01",
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const response = await call(
      endSiteTerms,
      event(undefined, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(
      transaction.input.TransactItems[1].Update.ExpressionAttributeValues[
        ":compliance"
      ],
    ).toEqual({
      perimeterChecksRequired: false,
    });
    expect(
      transaction.input.TransactItems[0].Update.UpdateExpression,
    ).toContain("endedOn = :today");
  });
});

describe("Site Program-contact assignments", () => {
  it("assigns a contact and designates the primary contact atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          leadProgramId: "program-1",
          status: "active",
        },
      })
      .mockResolvedValueOnce({
        Item: {
          userId: "user-1",
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0100",
          email: "sam@example.org",
          status: "active",
        },
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const response = await call(
      assignSiteUser,
      event({ userId: "user-1", primary: true }, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(201);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
      pk: "SITE#site-1",
      sk: "ASSIGNED_USER#user-1",
      programId: "program-1",
    });
  });

  it("requires a replacement before unassigning the primary contact", async () => {
    send
      .mockResolvedValueOnce({ Item: { primaryContactUserId: "user-1" } })
      .mockResolvedValueOnce({ Item: { userId: "user-1" } });
    const response = await call(
      unassignSiteUser,
      event(undefined, { siteId: "site-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "primary_contact_replacement_required",
    });
  });
});

describe("Site perimeter text", () => {
  it("returns the Site perimeter and its edit metadata", async () => {
    send.mockResolvedValueOnce({
      Item: {
        perimeter: "Along Mission Street",
        updatedAt: "2026-10-03T12:00:00.000Z",
        perimeterUpdatedAt: "2026-10-03T12:00:00.000Z",
        perimeterUpdatedBy: "admin-1",
      },
    });
    const response = await call(
      getSitePerimeter,
      event(undefined, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toMatchObject({
      perimeter: "Along Mission Street",
      perimeterUpdatedBy: "admin-1",
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });

  it("updates trimmed text and appends an audit event atomically", async () => {
    send.mockResolvedValueOnce({});
    const response = await call(
      putSitePerimeter,
      event(
        {
          perimeter: "  Both sides of Mission Street.  ",
          expectedUpdatedAt: "2026-10-03T12:00:00.000Z",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).perimeter).toBe(
      "Both sides of Mission Street.",
    );
    const transaction = send.mock.calls[0][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect(transaction.input.TransactItems[0].Update).toMatchObject({
      ConditionExpression:
        "attribute_exists(pk) AND updatedAt = :expectedUpdatedAt",
    });
    expect(transaction.input.TransactItems[1].Put.Item).toMatchObject({
      type: "siteAuditEvent",
      eventType: "perimeter_text_updated",
      actor: "admin-1",
    });
  });

  it("reports an optimistic-concurrency conflict", async () => {
    const error = new Error("changed");
    error.name = "TransactionCanceledException";
    send.mockRejectedValueOnce(error);
    const response = await call(
      putSitePerimeter,
      event(
        {
          perimeter: "Updated boundary",
          expectedUpdatedAt: "2026-10-03T12:00:00.000Z",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "perimeter_update_conflict",
    });
  });

  it("rejects perimeter text over the field limit", async () => {
    const response = await call(
      putSitePerimeter,
      event(
        {
          perimeter: "x".repeat(4001),
          expectedUpdatedAt: "2026-10-03T12:00:00.000Z",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects blank perimeter text without overwriting the stored value", async () => {
    const response = await call(
      putSitePerimeter,
      event(
        {
          perimeter: "   ",
          expectedUpdatedAt: "2026-10-03T12:00:00.000Z",
        },
        { siteId: "site-1" },
      ),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "perimeter_required",
    });
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * @param {unknown} body
 * @param {Record<string, string>} pathParameters
 * @returns {Record<string, unknown>}
 */
function event(body = undefined, pathParameters = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            "cognito:groups": "compliance-supervisor",
            sub: "admin-1",
          },
        },
      },
    },
  };
}

/**
 * @param {Function} handler
 * @param {any} request
 * @returns {Promise<import("aws-lambda").APIGatewayProxyStructuredResultV2>}
 */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, {}, () => {})
  );
}
