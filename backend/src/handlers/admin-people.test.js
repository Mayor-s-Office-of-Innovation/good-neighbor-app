import { beforeEach, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { updatePerson } = await import("./admin-people.js");
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
});
it("requires assignment to every site affected by a shared contact edit", async () => {
  send.mockImplementation(async (command) => {
    const key = command.input.Key;
    if (key.pk === "PEOPLE")
      return {
        Item: {
          personId: "p",
          status: "active",
          email: "person@example.org",
          sources: [
            { pk: "SITE#allowed", sk: "MANAGER_MEMBERSHIP#one" },
            { pk: "SITE#other", sk: "MANAGER_MEMBERSHIP#two" },
          ],
        },
      };
    if (key.pk.startsWith("ADMIN_DIRECTORY"))
      return { Item: { userId: "admin", status: "active" } };
    if (key.pk === "SITE#allowed") return { Item: { status: "active" } };
    return {};
  });
  const result = /** @type {any} */ (
    await updatePerson(
      /** @type {any} */ ({
        pathParameters: { personId: "p" },
        body: JSON.stringify({
          firstName: "New",
          lastName: "Name",
          email: "person@example.org",
        }),
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                "cognito:groups": ["compliance-manager"],
                email: "admin@example.org",
              },
            },
          },
        },
      }),
      /** @type {any} */ ({}),
      () => {},
    )
  );
  expect(result.statusCode).toBe(403);
  expect(
    send.mock.calls.some(
      ([command]) => command instanceof TransactWriteCommand,
    ),
  ).toBe(false);
});
