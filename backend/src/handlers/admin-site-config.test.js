import { ownProfile } from "./admin-users.js";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
// Contact-selection behavior and concurrency guards are covered in site-primary-contact.test.js.
vi.mock("../lib/site-primary-contact.js", () => ({
  sitePrimaryContactChange: vi.fn(async (tableName, siteId, now, change) => ({
    Update: {
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: "#META" },
      UpdateExpression: change.add
        ? "SET primaryContact = :contact"
        : "REMOVE primaryContactUserId, primaryContact",
      ExpressionAttributeValues: change.add ? { ":contact": change.add } : {},
    },
  })),
}));

vi.mock("./admin-users.js", () => ({
  ownProfile: vi.fn(async (event) => {
    const claims = event.requestContext.authorizer.jwt.claims;
    return {
      profile: {
        firstName: claims.given_name,
        lastName: claims.family_name,
        phone: claims.phone_number,
        email: claims.email,
      },
    };
  }),
}));

const {
  assignSiteUser,
  createSiteTerms,
  endSiteTerms,
  resendSiteLetter,
  getSitePerimeter,
  listSiteTerms,
  putSitePerimeter,
  replaceSiteComplianceManagers,
  unassignSiteUser,
} = await import("./admin-site-config.js");

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("effective-dated Site terms", () => {
  it("rejects the removed undocumented-conditions reason", async () => {
    const response = await call(
      createSiteTerms,
      event(
        {
          reasons: ["5"],
          siteManagerUserId: "contact-1",
          requiredChecksPerDay: 3,
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    if (typeof response.body !== "string") {
      throw new Error("Expected a JSON response body");
    }
    expect(JSON.parse(response.body).error).toBe("reasons_required");
  });
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

  it.each([false, true])(
    "creates terms from either manager representation with current contact details (%s)",
    async (membershipOnly) => {
      vi.mocked(ownProfile, { partial: true }).mockResolvedValueOnce({
        profile: {
          firstName: "Fresh",
          lastName: "Contact",
          phone: "+14155550123",
          phoneExtension: "",
          email: "fresh@example.org",
          role: "compliance-supervisor",
          directoryUserId: "",
        },
      });
      send
        .mockResolvedValueOnce({
          Item: {
            siteId: "site-1",
            name: "Site One",
            address: "1 Main St, San Francisco, CA 94102",
            status: "active",
            leadProgramId: "program-1",
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
          ...(membershipOnly
            ? {}
            : { Item: { status: "active", programId: "program-1" } }),
        })
        .mockResolvedValueOnce({
          Item: {
            userId: "contact-1",
            firstName: "Sam",
            lastName: "Lee",
            email: "sam@example.org",
            status: "active",
          },
        });
      if (membershipOnly)
        send.mockResolvedValueOnce({
          Items: [
            { status: "active", userId: "contact-1", membershipId: "m1" },
          ],
        });
      send
        .mockResolvedValueOnce({
          Items: [
            {
              status: "active",
              firstName: "Provider",
              lastName: "Manager",
              email: "provider@example.org",
            },
          ],
        })
        .mockResolvedValueOnce({ Item: { name: "Lead Program" } });
      const response = await call(
        createSiteTerms,
        event(
          {
            reasons: ["2", "6"],
            siteManagerUserId: "contact-1",
            underEnhancedMonitoring: true,
            requiredChecksPerDay: 3,
            effectiveStart: "2026-11-01",
            periodEnd: "2026-12-01",
          },
          { siteId: "site-1" },
        ),
      );
      expect(response.statusCode).toBe(201);
      expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
      const transaction = /** @type {any} */ (
        send.mock.calls
          .map(([c]) => c)
          .find((c) => c instanceof TransactWriteCommand)
      );
      expect(transaction).toBeInstanceOf(TransactWriteCommand);
      if (!transaction) throw new Error("Missing transaction");
      expect(transaction.input.TransactItems).toHaveLength(5);
      expect(
        transaction.input.TransactItems[0].Put.Item.underEnhancedMonitoring,
      ).toBe(true);
      expect(
        transaction.input.TransactItems[0].Put.Item.letterInputs
          .leadProgramName,
      ).toBe("Lead Program");
      expect(
        transaction.input.TransactItems[0].Put.Item.letterInputs
          .providerManagerNames,
      ).toEqual(["Provider Manager"]);
      expect(
        transaction.input.TransactItems[1].Update.ExpressionAttributeValues[
          ":compliance"
        ].underEnhancedMonitoring,
      ).toBe(true);
      expect(transaction.input.TransactItems[0].Put.Item.effectiveStart).toBe(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Los_Angeles",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date()),
      );
      expect(
        transaction.input.TransactItems[0].Put.Item.letterInputs,
      ).toMatchObject({
        siteManagerId: "contact-1",
        siteManagerName: "Sam Lee",
        generatedByRole: "compliance-supervisor",
        programManagerName: "Fresh Contact",
        programManagerPhone: "+14155550123",
        programManagerEmail: "fresh@example.org",
      });
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
          (/** @type {any} */ item) =>
            item.Put?.Item?.type === "siteAuditEvent",
        ),
      ).toBe(true);
    },
  );

  it("rejects overlapping future terms", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          name: "Site One",
          address: "1 Main St",
          status: "active",
          leadProgramId: "program-1",
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
        Item: { status: "active", programId: "program-1" },
      })
      .mockResolvedValueOnce({
        Item: {
          userId: "contact-1",
          firstName: "Sam",
          lastName: "Lee",
          email: "sam@example.org",
          status: "active",
        },
      });
    const response = await call(
      createSiteTerms,
      event(
        {
          reasons: ["2"],
          siteManagerUserId: "contact-1",
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
          siteManagerUserId: "contact-1",
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
          leadProgramId: "program-1",
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
        Item: { status: "active", programId: "program-1" },
      })
      .mockResolvedValueOnce({
        Item: {
          userId: "contact-1",
          firstName: "Sam",
          lastName: "Lee",
          email: "sam@example.org",
          status: "active",
        },
      })
      .mockResolvedValueOnce({});

    const response = await call(
      createSiteTerms,
      event(
        {
          reasons: ["2"],
          siteManagerUserId: "contact-1",
          requiredChecksPerDay: 3,
        },
        { siteId: "site-1" },
      ),
    );

    expect(response.statusCode).toBe(201);
  });

  it("ends the active period and clears the current compliance projection", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          siteId: "site-1",
          status: "active",
          complianceLetters: {
            current: { s3Key: "current.pdf" },
            past: [{ s3Key: "past.pdf" }],
          },
        },
      })
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
    const query = send.mock.calls[1][0];
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input.ConsistentRead).toBe(true);
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(
      transaction.input.TransactItems[1].Update.ExpressionAttributeValues[
        ":letters"
      ],
    ).toEqual({
      current: null,
      past: [{ s3Key: "current.pdf" }, { s3Key: "past.pdf" }],
    });
    expect(
      transaction.input.TransactItems[1].Update.UpdateExpression,
    ).toContain("REMOVE latestComplianceTermsVersionId");
    expect(
      transaction.input.TransactItems[1].Update.ExpressionAttributeValues[
        ":compliance"
      ],
    ).toEqual({
      perimeterChecksRequired: false,
      underEnhancedMonitoring: false,
    });
    expect(
      transaction.input.TransactItems[0].Update.UpdateExpression,
    ).toContain("endedOn = :today");
  });

  it("returns a conflict when the active period changes during close", async () => {
    const conflict = new Error("changed");
    conflict.name = "TransactionCanceledException";
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
      .mockRejectedValueOnce(conflict);

    const response = await call(
      endSiteTerms,
      event(undefined, { siteId: "site-1" }),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "terms_close_conflict",
    });
  });
});

describe("resend current letter", () => {
  it("queues the original email and attachment rather than caller-supplied recipients", async () => {
    const letter = {
      s3Key: "saved.pdf",
      effectiveStart: "2026-10-16",
      termsVersionId: "v1",
    };
    const email = {
      to: "site@example.org",
      cc: ["original@example.org"],
      text: "Original text",
    };
    send
      .mockResolvedValueOnce({
        Item: { status: "active", complianceLetters: { current: letter } },
      })
      .mockResolvedValueOnce({ Item: { email } })
      .mockResolvedValueOnce({});
    const response = await call(
      resendSiteLetter,
      event(
        {
          requestId: "00000000-0000-0000-0000-000000000001",
          to: "other@example.org",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(202);
    expect(send.mock.calls[2][0].input.TransactItems[1].Put.Item).toMatchObject(
      { resend: true, letter, email },
    );
  });
  it("rejects resend when the current letter has been cleared", async () => {
    send.mockResolvedValueOnce({
      Item: { status: "active", complianceLetters: { current: null } },
    });
    const response = await call(
      resendSiteLetter,
      event(
        { requestId: "00000000-0000-0000-0000-000000000001" },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("Site Compliance manager assignments", () => {
  it("replaces assignments transactionally", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockResolvedValueOnce({
        Items: [
          { userId: "manager-1", email: "one@sfgov.org", status: "active" },
          { userId: "manager-2", email: "two@sfgov.org", status: "active" },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "COMPLIANCE_MANAGER#manager-1",
            managerId: "manager-1",
            status: "active",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      replaceSiteComplianceManagers,
      event({ managerIds: ["manager-2"] }, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Put: expect.any(Object) }),
        expect.objectContaining({ Delete: expect.any(Object) }),
      ]),
    );
  });

  it("reactivates a requested inactive assignment", async () => {
    send
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockResolvedValueOnce({
        Items: [
          { userId: "manager-1", email: "one@sfgov.org", status: "active" },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "COMPLIANCE_MANAGER#manager-1",
            managerId: "manager-1",
            status: "inactive",
          },
        ],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      replaceSiteComplianceManagers,
      event({ managerIds: ["manager-1"] }, { siteId: "site-1" }),
    );
    expect(response.statusCode).toBe(200);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            Key: {
              pk: "SITE#site-1",
              sk: "COMPLIANCE_MANAGER#manager-1",
            },
            ExpressionAttributeValues: expect.objectContaining({
              ":active": "active",
              ":inactive": "inactive",
            }),
          }),
        }),
      ]),
    );
  });

  it("limits a Site to two Program managers", async () => {
    const response = await call(
      replaceSiteComplianceManagers,
      event(
        { managerIds: ["manager-1", "manager-2", "manager-3"] },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "too_many_compliance_managers",
    });
    expect(send).not.toHaveBeenCalled();
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

  it("unassigns the last manager and clears the primary contact atomically", async () => {
    send
      .mockResolvedValueOnce({ Item: { primaryContactUserId: "user-1" } })
      .mockResolvedValueOnce({
        Item: { userId: "user-1", programId: "program-1" },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    const response = await call(
      unassignSiteUser,
      event(undefined, { siteId: "site-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(200);
    const items = send.mock.calls[3][0].input.TransactItems;
    expect(
      items.some((/** @type {any} */ item) =>
        item.Update?.UpdateExpression.includes(
          "REMOVE primaryContactUserId, primaryContact",
        ),
      ),
    ).toBe(true);
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
            email: "supervisor@sfgov.org",
            given_name: "Robin",
            family_name: "Supervisor",
            phone_number: "415-555-0199",
            "custom:department": "Department of Public Health (DPH)",
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

it("rejects ambiguous legacy unassignment before deactivating any membership", async () => {
  send
    .mockResolvedValueOnce({ Item: { siteId: "site-1" } })
    .mockResolvedValueOnce({
      Item: { userId: "u1", email: "shared@example.org", programId: "p1" },
    })
    .mockResolvedValueOnce({
      Items: [
        { membershipId: "explicit", status: "active", userId: "u1" },
        {
          membershipId: "legacy",
          status: "active",
          email: "shared@example.org",
        },
      ],
    })
    .mockResolvedValueOnce({
      Items: [
        { userId: "u1", email: "shared@example.org" },
        { userId: "u2", email: "shared@example.org" },
      ],
    });
  const response = await call(
    unassignSiteUser,
    event(undefined, { siteId: "site-1", userId: "u1" }),
  );
  expect(response.statusCode).toBe(409);
  expect(JSON.parse(String(response.body)).error).toBe(
    "ambiguous_manager_identity",
  );
  expect(send.mock.calls).toHaveLength(4);
});
