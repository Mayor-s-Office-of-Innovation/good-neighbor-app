import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { createOversightOption, listOversightOptions } = await import(
  "./admin-oversight.js"
);

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("oversight option directory", () => {
  it("lists defaults and persisted options", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          optionType: "systemOfCare",
          name: "Housing",
          status: "active",
        },
      ],
    });
    const response = await call(listOversightOptions, event());
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(JSON.parse(String(response.body))).toMatchObject({
      departments: [],
      systemsOfCare: expect.arrayContaining([
        expect.objectContaining({ name: "Housing" }),
      ]),
    });
  });

  it("creates a reusable oversight option", async () => {
    send.mockResolvedValueOnce({});
    const response = await call(
      createOversightOption,
      event({ type: "department", name: "DEM" }),
    );
    expect(response.statusCode).toBe(201);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input.Item).toMatchObject({
      pk: "ADMIN_DIRECTORY#OVERSIGHT",
      sk: "DEPARTMENT#dem",
      optionType: "department",
      name: "DEM",
    });
  });
});

/** @param {unknown} [body] */
function event(body = undefined) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": "compliance-supervisor" } },
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
