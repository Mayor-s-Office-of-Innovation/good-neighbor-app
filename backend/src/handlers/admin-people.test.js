import { beforeEach, expect, it, vi } from "vitest";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
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
 * A compliance manager editing a program staff person whose `sources` list
 * only SITE#allowed. The assignment pointers say where the person really is.
 * @param {{
 *   leadProgramId?: string,
 *   pointedSites?: string[],
 *   assignmentCount?: number,
 *   managedSites?: string[],
 * }} [setup]
 */
function programStaffEdit({
  leadProgramId = "lead",
  pointedSites = ["allowed", "other"],
  assignmentCount = 2,
  managedSites = ["allowed"],
} = {}) {
  send.mockImplementation(async (command) => {
    if (command instanceof TransactWriteCommand) return {};
    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {};
      if (values[":prefix"] === "USER_SITE#u1#")
        return { Items: pointedSites.map((siteId) => ({ siteId })) };
      return { Items: [] };
    }
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
    if (sk === "COMPLIANCE_MANAGER#admin")
      return managedSites.includes(String(pk).slice(5))
        ? { Item: { status: "active" } }
        : {};
    if (pk === "SITE#allowed" && sk === "#META")
      return { Item: { status: "active", leadProgramId } };
    if (pk === "PROGRAM#lead")
      return {
        Item: { pk, sk, personId: "p", siteAssignmentCount: assignmentCount },
      };
    if (sk === "ASSIGNED_USER#u1")
      return { Item: { pk, sk, personId: "p", status: "active" } };
    return {};
  });
  return /** @type {Promise<any>} */ (
    updatePerson(
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
    )
  );
}

const saved = () =>
  send.mock.calls.some(([command]) => command instanceof TransactWriteCommand);

it("refuses a program staff edit when the person is also shown at a Site the editor doesn't manage", async () => {
  // `sources` lists only SITE#allowed, but the pointers find SITE#other too.
  const result = await programStaffEdit({ managedSites: ["allowed"] });
  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body)).toEqual({
    error: "site_assignment_required",
  });
  expect(saved()).toBe(false);
});

it("lets a manager of every assigned Site edit program staff", async () => {
  const result = await programStaffEdit({ managedSites: ["allowed", "other"] });
  expect(result.statusCode).toBe(200);
  expect(saved()).toBe(true);
});

it("sends the edit to a supervisor when the pointers and the assignment count disagree", async () => {
  const result = await programStaffEdit({
    pointedSites: ["allowed"],
    assignmentCount: 2,
    managedSites: ["allowed", "other"],
  });
  expect(result.statusCode).toBe(403);
  expect(JSON.parse(result.body)).toEqual({ error: "supervisor_required" });
  expect(saved()).toBe(false);
});

it("refuses a program staff edit from a Site that program doesn't lead", async () => {
  const result = await programStaffEdit({
    leadProgramId: "another-program",
    managedSites: ["allowed", "other"],
  });
  expect(result.statusCode).toBe(403);
  expect(saved()).toBe(false);
});
