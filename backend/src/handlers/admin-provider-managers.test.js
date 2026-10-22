vi.mock("./enrollment-codes.js", async (importOriginal) => ({
  ...(await importOriginal()),
  generateEnrollmentCode: vi.fn(async () => "0AB123"),
}));
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, sendProviderManagerEnrollmentEmail } = vi.hoisted(() => ({
  send: vi.fn(),
  sendProviderManagerEnrollmentEmail: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/email.js", () => ({
  sendProviderManagerEnrollmentEmail,
}));

const {
  createProviderManagerGrant,
  listProviderManagers,
  revokeProviderManagerEnrollment,
} = await import("./admin-provider-managers.js");

beforeEach(() => {
  send.mockReset();
  sendProviderManagerEnrollmentEmail.mockReset().mockResolvedValue({
    provider: "ses",
    messageId: "message-1",
  });
  vi.stubEnv("SETUP_CODE_VERIFIER_SECRET", "test-setup-secret");
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("PROVIDER_APP_URL", "https://goodneighborsf.org/");
});

describe("Provider Manager administration", () => {
  it("rejects a Compliance manager before reading provider data", async () => {
    const response = await call(
      listProviderManagers,
      event(undefined, { providerId: "provider-1" }, "compliance-manager"),
    );

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "supervisor_required",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a grant when a Provider has more than 21 active Sites", async () => {
    send
      .mockResolvedValueOnce({
        Item: { providerId: "provider-1", name: "Provider One" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            membershipId: "membership-1",
            status: "active",
            generation: 2,
            name: "Alex Rivera",
            email: "alex@example.org",
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: Array.from({ length: 22 }, (_, index) => ({
          siteId: `site-${index + 1}`,
          status: "active",
        })),
      })
      .mockResolvedValueOnce({});

    const response = await call(
      createProviderManagerGrant,
      event(
        { membershipId: "membership-1" },
        { providerId: "provider-1" },
        "compliance-supervisor",
      ),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "provider_site_limit_exceeded",
      siteCount: 22,
      limit: 21,
    });
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
    expect(sendProviderManagerEnrollmentEmail).not.toHaveBeenCalled();
  });

  it("counts every Site query page before enforcing the enrollment limit", async () => {
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        if (command.input.Key?.sk === "#META") {
          return { Item: { providerId: "provider-1", name: "Provider One" } };
        }
        return {};
      }
      if (command instanceof QueryCommand) {
        const prefix = command.input.ExpressionAttributeValues?.[":prefix"];
        if (prefix === "PROVIDER_MANAGER#") {
          return {
            Items: [
              {
                membershipId: "membership-1",
                status: "active",
                generation: 1,
                name: "Alex Rivera",
                email: "alex@example.org",
              },
            ],
          };
        }
        if (prefix === "SITE#" && !command.input.ExclusiveStartKey) {
          return {
            Items: Array.from({ length: 20 }, (_, index) => ({
              siteId: `site-${index + 1}`,
              status: "active",
            })),
            LastEvaluatedKey: {
              pk: "PROVIDER#provider-1",
              sk: "SITE#site-20",
            },
          };
        }
        if (prefix === "SITE#") {
          return {
            Items: [
              { siteId: "site-21", status: "active" },
              { siteId: "site-22", status: "active" },
            ],
          };
        }
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    const response = await call(
      createProviderManagerGrant,
      event(
        { membershipId: "membership-1" },
        { providerId: "provider-1" },
        "compliance-supervisor",
      ),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body)).siteCount).toBe(22);
    const siteQueries = send.mock.calls
      .map(([command]) => command)
      .filter(
        (command) =>
          command instanceof QueryCommand &&
          command.input.ExpressionAttributeValues?.[":prefix"] === "SITE#",
      );
    expect(siteQueries).toHaveLength(2);
    expect(siteQueries[1].input.ExclusiveStartKey).toBeTruthy();
  });

  it("does not replace an unexpired link while delivery may be in flight", async () => {
    send
      .mockResolvedValueOnce({
        Item: { providerId: "provider-1", name: "Provider One" },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            membershipId: "membership-1",
            status: "active",
            generation: 1,
            name: "Alex Rivera",
            email: "alex@example.org",
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [{ siteId: "site-1", status: "active" }],
      })
      .mockResolvedValueOnce({
        Item: { grantId: "grant-current", expiresAt: "2099-01-01T00:00:00Z" },
      });

    const response = await call(
      createProviderManagerGrant,
      event(
        { membershipId: "membership-1" },
        { providerId: "provider-1" },
        "compliance-supervisor",
      ),
    );

    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "provider_manager_grant_already_active",
    });
    expect(sendProviderManagerEnrollmentEmail).not.toHaveBeenCalled();
  });

  it.each(["link", "code"])(
    "records delivery evidence without requiring the grant to remain pending (%s)",
    async (deliveryMode) => {
      send
        .mockResolvedValueOnce({
          Item: { providerId: "provider-1", name: "Provider One" },
        })
        .mockResolvedValueOnce({
          Items: [
            {
              membershipId: "membership-1",
              status: "active",
              generation: 1,
              name: "Alex Rivera",
              email: "alex@example.org",
            },
          ],
        })
        .mockResolvedValueOnce({
          Items: [{ siteId: "site-1", status: "active" }],
        })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});

      const response = await call(
        createProviderManagerGrant,
        event(
          { membershipId: "membership-1", deliveryMode },
          { providerId: "provider-1" },
          "compliance-supervisor",
        ),
      );

      expect(response.statusCode).toBe(201);
      const message = sendProviderManagerEnrollmentEmail.mock.calls[0][0];
      if (deliveryMode === "code") {
        expect(message.enrollmentCode).toMatch(/^[A-Z0-9]{6}$/);
        expect(new URL(message.enrollmentUrl).hash).toBe("#login=1");
        expect(JSON.stringify(response)).not.toContain(message.enrollmentCode);
        const writes = send.mock.calls.filter(
          ([c]) => c instanceof TransactWriteCommand,
        )[0][0].input.TransactItems;
        expect(JSON.stringify(writes)).not.toContain(
          message.enrollmentCode.replaceAll("-", ""),
        );
      } else {
        expect(message.enrollmentCode).toBeUndefined();
        expect(message.enrollmentUrl).toContain("enrollment_token=");
      }

      const grant = JSON.parse(String(response.body)).grant;
      expect(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt)).toBe(
        24 * 60 * 60 * 1000,
      );
      const deliveryUpdate = send.mock.calls[5][0];
      expect(deliveryUpdate.constructor.name).toBe("UpdateCommand");
      expect(deliveryUpdate.input.ConditionExpression).toBe(
        "attribute_exists(pk)",
      );
    },
  );

  it("paginates managers and derives enrollment state from live rows", async () => {
    send.mockImplementation(async (command) => {
      if (command instanceof GetCommand) {
        return { Item: { providerId: "provider-1", name: "Provider One" } };
      }
      if (command instanceof QueryCommand) {
        const prefix = command.input.ExpressionAttributeValues?.[":prefix"];
        if (prefix === "PROVIDER_MANAGER#") {
          return command.input.ExclusiveStartKey
            ? {
                Items: [
                  {
                    membershipId: "membership-2",
                    status: "active",
                    name: "Manager Two",
                  },
                ],
              }
            : {
                Items: [
                  {
                    membershipId: "membership-1",
                    status: "active",
                    name: "Manager One",
                  },
                ],
                LastEvaluatedKey: {
                  pk: "PROVIDER#provider-1",
                  sk: "PROVIDER_MANAGER#membership-1",
                },
              };
        }
        if (prefix === "PROVIDER_MANAGER_ENROLLMENT#") {
          return {
            Items: [
              {
                enrollmentId: "enrollment-1",
                membershipId: "membership-1",
                physicalDeviceId: "physical-1",
                status: "active",
                siteCount: 1,
                siteBindings: [{ siteId: "site-1", bindingId: "binding-1" }],
              },
            ],
          };
        }
      }
      if (command instanceof BatchGetCommand) {
        return {
          Responses: {
            "gnp-test-app": [
              {
                pk: "PHYSICAL_DEVICE#physical-1",
                sk: "#META",
                status: "revoked",
              },
              {
                pk: "SITE#site-1",
                sk: "DEVICE_BINDING#binding-1",
                status: "active",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    const response = await call(
      listProviderManagers,
      event(undefined, { providerId: "provider-1" }, "compliance-supervisor"),
    );
    const body = JSON.parse(String(response.body));
    expect(body.managers).toHaveLength(2);
    expect(body.managers[0].activeDeviceCount).toBe(0);
    expect(body.enrollments[0]).toMatchObject({
      enrollmentId: "enrollment-1",
      status: "revoked",
      activeSiteCount: 0,
    });
  });

  it("uses the direct enrollment key and skips already-revoked bindings", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          pk: "PROVIDER#provider-1",
          sk: "PROVIDER_MANAGER_ENROLLMENT#enrollment-1",
          enrollmentId: "enrollment-1",
          membershipId: "membership-1",
          physicalDeviceId: "physical-1",
          status: "active",
          siteBindings: [
            { siteId: "site-1", bindingId: "binding-1" },
            { siteId: "site-2", bindingId: "binding-2" },
          ],
        },
      })
      .mockResolvedValueOnce({ Item: { status: "revoked" } })
      .mockResolvedValueOnce({ Item: { status: "active" } })
      .mockResolvedValueOnce({});

    const response = await call(
      revokeProviderManagerEnrollment,
      event(
        undefined,
        { providerId: "provider-1", enrollmentId: "enrollment-1" },
        "compliance-supervisor",
      ),
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body)).revokedBindingCount).toBe(1);
    const transaction = send.mock.calls[3][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(5);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
  });
});

/**
 * @param {unknown} body
 * @param {Record<string, string>} pathParameters
 * @param {string} group
 */
function event(body, pathParameters, group) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": group, sub: "admin-1" } },
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
