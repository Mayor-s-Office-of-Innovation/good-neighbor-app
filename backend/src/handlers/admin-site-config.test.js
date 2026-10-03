import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { assignSiteUser, createSiteTerms, listSiteTerms, unassignSiteUser } =
  await import("./admin-site-config.js");

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
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockResolvedValueOnce({
        Items: [
          {
            pk: "SITE#site-1",
            sk: "COMPLIANCE_TERMS#2026-01-01#old",
            effectiveStart: "2026-01-01",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const response = await call(
      createSiteTerms,
      event(
        {
          tier: 2,
          requiredChecksPerDay: 3,
          effectiveStart: "2026-11-01",
          expiresOnExclusive: "",
        },
        { siteId: "site-1" },
      ),
    );
    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[2][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(5);
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
      .mockResolvedValueOnce({ Item: { siteId: "site-1", status: "active" } })
      .mockResolvedValueOnce({
        Items: [{ effectiveStart: "2027-01-01", status: "scheduled" }],
      });
    const response = await call(
      createSiteTerms,
      event(
        {
          tier: 3,
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
            "cognito:groups": "central-admin",
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
