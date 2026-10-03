import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const {
  createProgram,
  createProgramUser,
  deactivateProgramUser,
  deactivateProgram,
  getProgram,
  listPrograms,
  updateProgram,
  updateProgramUser,
} = await import("./admin-programs.js");

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
});

describe("program administration", () => {
  it("lists active program search rows", async () => {
    send.mockResolvedValueOnce({ Items: [{ programId: "p-1" }] });
    const response = await call(listPrograms, event());
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
  });

  it("creates a program and both relationship projections atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: { providerId: "provider-1", name: "Provider", status: "active" },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      createProgram,
      event({ name: "Program One", providerId: "provider-1" }),
    );
    expect(response.statusCode).toBe(201);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toHaveLength(3);
    expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
      pk: "PROGRAM#provider-1-program-one",
      providerId: "provider-1",
    });
  });

  it("loads a program with sites and users", async () => {
    send
      .mockResolvedValueOnce({ Item: { programId: "program-1" } })
      .mockResolvedValueOnce({ Items: [{ siteId: "site-1" }] })
      .mockResolvedValueOnce({ Items: [{ userId: "user-1" }] });
    const response = await call(
      getProgram,
      event(undefined, { programId: "program-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(String(response.body))).toMatchObject({
      sites: [{ siteId: "site-1" }],
      users: [{ userId: "user-1" }],
    });
  });

  it("creates a non-authenticating program contact atomically", async () => {
    send
      .mockResolvedValueOnce({
        Item: { programId: "program-1", status: "active" },
      })
      .mockResolvedValueOnce({});
    const response = await call(
      createProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0100",
          email: "SAM@example.org",
        },
        { programId: "program-1" },
      ),
    );
    expect(response.statusCode).toBe(201);
    const transaction = send.mock.calls[1][0];
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems[0].Put.Item).toMatchObject({
      pk: "PROGRAM#program-1",
      type: "programUser",
      firstName: "Sam",
      lastName: "Lee",
      email: "sam@example.org",
      status: "active",
      siteAssignmentCount: 0,
    });
  });

  it("rejects a program contact without a valid email", async () => {
    const response = await call(
      createProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0100",
          email: "not-an-email",
        },
        { programId: "program-1" },
      ),
    );
    expect(response.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("updates a program contact in place", async () => {
    send.mockResolvedValueOnce({ Attributes: { userId: "user-1" } });
    const response = await call(
      updateProgramUser,
      event(
        {
          firstName: "Sam",
          lastName: "Lee",
          phone: "415-555-0101",
          email: "sam@example.org",
        },
        { programId: "program-1", userId: "user-1" },
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
  });

  it("archives an unassigned program contact without deleting history", async () => {
    send.mockResolvedValueOnce({ Attributes: { status: "inactive" } });
    const response = await call(
      deactivateProgramUser,
      event(undefined, { programId: "program-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(200);
    const command = send.mock.calls[0][0];
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input.ConditionExpression).toContain(
      "siteAssignmentCount = :zero",
    );
  });

  it("does not archive a program contact that still has Site dependencies", async () => {
    const conflict = new Error("assigned");
    conflict.name = "ConditionalCheckFailedException";
    send.mockRejectedValueOnce(conflict);
    const response = await call(
      deactivateProgramUser,
      event(undefined, { programId: "program-1", userId: "user-1" }),
    );
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "program_user_in_use",
    });
  });

  it("updates program details", async () => {
    send.mockResolvedValueOnce({ Attributes: { programId: "program-1" } });
    const response = await call(
      updateProgram,
      event({ name: "Renamed" }, { programId: "program-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(UpdateCommand);
  });

  it("archives only the program and search row", async () => {
    send
      .mockResolvedValueOnce({
        Item: { programId: "program-1", name: "Program One" },
      })
      .mockResolvedValueOnce({ Attributes: { status: "inactive" } })
      .mockResolvedValueOnce({});
    const response = await call(
      deactivateProgram,
      event(undefined, { programId: "program-1" }),
    );
    expect(response.statusCode).toBe(200);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(UpdateCommand);
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteCommand);
    expect(
      send.mock.calls.some(
        ([command]) => command instanceof TransactWriteCommand,
      ),
    ).toBe(false);
  });
});

/** @param {unknown} body @param {Record<string, string>} pathParameters */
function event(body = undefined, pathParameters = {}) {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    pathParameters,
    requestContext: {
      authorizer: {
        jwt: { claims: { "cognito:groups": "central-admin" } },
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
