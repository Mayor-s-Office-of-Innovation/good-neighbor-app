import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, sendProviderManagerEnrollmentEmail } = vi.hoisted(() => ({
  send: vi.fn(),
  sendProviderManagerEnrollmentEmail: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../integrations/email.js", () => ({
  sendProviderManagerEnrollmentEmail,
}));

const { createProviderManagerGrant, listProviderManagers } = await import(
  "./admin-provider-managers.js"
);

beforeEach(() => {
  send.mockReset();
  sendProviderManagerEnrollmentEmail.mockReset().mockResolvedValue({
    provider: "ses",
    messageId: "message-1",
  });
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
