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

/**
 * A compliance manager assigned to SITE#allowed, editing a program staff
 * person whose `sources` list only that Site.
 * @param {{ leadProgramId: string }} site
 */
function programStaffEdit({ leadProgramId }) {
  send.mockImplementation(async (command) => {
    if (command instanceof TransactWriteCommand) return {};
    const { pk, sk } = command.input.Key ?? {};
    if (pk === "PEOPLE")
      return {
        Item: {
          personId: "p",
          status: "active",
          email: "person@example.org",
          sources: [
            { pk: "PROGRAM#lead", sk: "USER#u1" },
            { pk: "SITE#allowed", sk: "ASSIGNED_USER#u1" },
          ],
        },
      };
    if (pk?.startsWith("ADMIN_DIRECTORY"))
      return {
        Item: {
          userId: "admin",
          status: "active",
          cognitoSubject: "admin-sub",
        },
      };
    if (pk === "SITE#allowed" && sk === "COMPLIANCE_MANAGER#admin")
      return { Item: { status: "active" } };
    if (pk === "SITE#allowed" && sk === "#META")
      return { Item: { status: "active", leadProgramId } };
    // Assigned at a second Site too, which `sources` doesn't list.
    if (pk === "PROGRAM#lead")
      return { Item: { pk, sk, personId: "p", siteAssignmentCount: 2 } };
    if (pk === "SITE#allowed" && sk === "ASSIGNED_USER#u1")
      return { Item: { pk, sk, personId: "p", status: "active" } };
    return {};
  });
  return updatePerson(
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
              "cognito:username": "admin@example.org",
              email: "admin@example.org",
              email_verified: true,
              sub: "admin-sub",
            },
          },
        },
      },
    }),
    /** @type {any} */ ({}),
    () => {},
  );
}

it("lets a manager edit program staff from a Site that program leads, even with assignments elsewhere", async () => {
  const result = /** @type {any} */ (
    await programStaffEdit({ leadProgramId: "lead" })
  );
  expect(result.statusCode).toBe(200);
  expect(
    send.mock.calls.some(
      ([command]) => command instanceof TransactWriteCommand,
    ),
  ).toBe(true);
});

it("refuses a program staff edit from a Site that program doesn't lead", async () => {
  const result = /** @type {any} */ (
    await programStaffEdit({ leadProgramId: "another-program" })
  );
  expect(result.statusCode).toBe(403);
  expect(
    send.mock.calls.some(
      ([command]) => command instanceof TransactWriteCommand,
    ),
  ).toBe(false);
});
