import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { cognitoSend, ddbSend } = vi.hoisted(() => ({
  cognitoSend: vi.fn(),
  ddbSend: vi.fn(),
}));

vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual =
    /** @type {typeof import("@aws-sdk/client-cognito-identity-provider")} */ (
      await importOriginal()
    );
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      send = cognitoSend;
    },
  };
});
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));

const {
  inviteAdminUser,
  reinviteAdminUser,
  resetAdminUserPassword,
  suspendAdminUser,
  updateAdminUserRole,
} = await import("./admin-users.js");

beforeEach(() => {
  cognitoSend.mockReset();
  ddbSend.mockReset();
  vi.stubEnv("COGNITO_USER_POOL_ID", "pool-1");
  vi.stubEnv("DYNAMO_TABLE", "gnp-test-app");
  vi.stubEnv("S3_UPLOAD_BUCKET", "uploads");
  vi.stubEnv("SQS_QUEUE_URL", "queue");
});

describe("Compliance administrator lifecycle", () => {
  it("rejects an invalid invitation email before calling Cognito", async () => {
    const response = await call(
      inviteAdminUser,
      event({
        email: "not-an-email",
        firstName: "New",
        lastName: "Admin",
        role: "compliance-manager",
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "valid_email_required",
    });
    expect(cognitoSend).not.toHaveBeenCalled();
  });

  it("deletes a newly created account when group assignment fails", async () => {
    const assignmentError = new Error("group unavailable");
    cognitoSend
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(assignmentError)
      .mockResolvedValueOnce({});

    const response = await call(
      inviteAdminUser,
      event({
        email: "new@example.org",
        firstName: "New",
        lastName: "Admin",
        role: "compliance-manager",
      }),
    );

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(String(response.body))).toEqual({
      error: "admin_group_assignment_failed",
      rollback: "completed",
    });
    expect(cognitoSend.mock.calls[0][0]).toBeInstanceOf(AdminCreateUserCommand);
    expect(cognitoSend.mock.calls[1][0]).toBeInstanceOf(
      AdminAddUserToGroupCommand,
    );
    expect(cognitoSend.mock.calls[2][0]).toBeInstanceOf(AdminDeleteUserCommand);
  });

  it("repairs a pre-existing account with no group memberships", async () => {
    const exists = new Error("exists");
    exists.name = "UsernameExistsException";
    cognitoSend
      .mockRejectedValueOnce(exists)
      .mockResolvedValueOnce(user("new@example.org", "new-sub"))
      .mockResolvedValueOnce({ Groups: [] })
      .mockResolvedValueOnce({});

    const response = await call(
      inviteAdminUser,
      event({
        email: "new@example.org",
        firstName: "New",
        lastName: "Admin",
        role: "compliance-manager",
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(cognitoSend.mock.calls[1][0]).toBeInstanceOf(AdminGetUserCommand);
    expect(cognitoSend.mock.calls[2][0]).toBeInstanceOf(
      AdminListGroupsForUserCommand,
    );
    expect(cognitoSend.mock.calls[3][0]).toBeInstanceOf(
      AdminAddUserToGroupCommand,
    );
  });

  it("adds the destination role before removing old memberships", async () => {
    ddbSend.mockResolvedValue({});
    cognitoSend.mockImplementation(async (command) => {
      if (command instanceof AdminGetUserCommand)
        return user("manager@example.org", "manager-sub");
      if (command instanceof ListUsersInGroupCommand)
        return { Users: [user("supervisor@example.org", "supervisor-sub")] };
      if (
        command instanceof AdminRemoveUserFromGroupCommand &&
        command.input.GroupName === "central-admin"
      ) {
        throw new Error("temporary cleanup failure");
      }
      return {};
    });

    const response = await call(
      updateAdminUserRole,
      event(
        { role: "compliance-manager" },
        { username: "manager@example.org" },
      ),
    );
    const commands = cognitoSend.mock.calls.map(([command]) => command);
    const addIndex = commands.findIndex(
      (command) => command instanceof AdminAddUserToGroupCommand,
    );
    const removeIndex = commands.findIndex(
      (command) => command instanceof AdminRemoveUserFromGroupCommand,
    );
    expect(addIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeGreaterThan(addIndex);
    expect(JSON.parse(String(response.body))).toMatchObject({
      warning: "role_cleanup_incomplete",
      cleanupFailures: ["central-admin"],
    });
    expect(ddbSend.mock.calls[0][0]).toBeInstanceOf(PutCommand);
    expect(ddbSend.mock.calls.at(-1)?.[0]).toBeInstanceOf(DeleteCommand);
    expect(ddbSend.mock.calls.at(-1)?.[0].input).toMatchObject({
      ConditionExpression: "#token = :token",
      ExpressionAttributeNames: { "#token": "token" },
    });
  });

  it("serializes concurrent suspensions so both cannot pass the invariant check", async () => {
    let locked = false;
    ddbSend.mockImplementation(async (command) => {
      if (command instanceof PutCommand) {
        if (locked) {
          const conflict = new Error("locked");
          conflict.name = "ConditionalCheckFailedException";
          throw conflict;
        }
        locked = true;
      }
      if (command instanceof DeleteCommand) locked = false;
      return {};
    });
    /** @type {((value?: unknown) => void) | undefined} */
    let releaseSupervisorList;
    const supervisorListBlocked = new Promise((resolve) => {
      releaseSupervisorList = resolve;
    });
    cognitoSend.mockImplementation(async (command) => {
      if (command instanceof AdminGetUserCommand) {
        const username = String(command.input.Username);
        return user(username, `${username}-sub`);
      }
      if (command instanceof ListUsersInGroupCommand) {
        await supervisorListBlocked;
        return {
          Users: [
            user("one@example.org", "one@example.org-sub"),
            user("two@example.org", "two@example.org-sub"),
          ],
        };
      }
      if (command instanceof AdminDisableUserCommand) return {};
      return {};
    });

    const first = call(
      suspendAdminUser,
      event(undefined, { username: "one@example.org" }),
    );
    await vi.waitFor(() => expect(locked).toBe(true));
    const second = await call(
      suspendAdminUser,
      event(undefined, { username: "two@example.org" }),
    );
    releaseSupervisorList?.();
    const firstResponse = await first;

    expect(firstResponse.statusCode).toBe(200);
    expect(JSON.parse(String(firstResponse.body))).toMatchObject({
      user: { enabled: false, lifecycleStatus: "suspended" },
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(String(second.body))).toEqual({
      error: "admin_user_change_in_progress",
    });
    expect(
      cognitoSend.mock.calls.filter(
        ([command]) => command instanceof AdminDisableUserCommand,
      ),
    ).toHaveLength(1);
  });

  it("resends a pending invitation for an administrator", async () => {
    cognitoSend
      .mockResolvedValueOnce(
        user("invited@example.org", "invited-sub", "FORCE_CHANGE_PASSWORD"),
      )
      .mockResolvedValueOnce({ Groups: [{ GroupName: "compliance-manager" }] })
      .mockResolvedValueOnce({});

    const response = await call(
      reinviteAdminUser,
      event(undefined, { username: "invited@example.org" }),
    );

    expect(response.statusCode).toBe(200);
    expect(cognitoSend.mock.calls[2][0]).toBeInstanceOf(AdminCreateUserCommand);
    expect(cognitoSend.mock.calls[2][0].input).toMatchObject({
      MessageAction: "RESEND",
      Username: "invited@example.org",
    });
  });

  it("sends password-reset instructions only for an active administrator", async () => {
    cognitoSend
      .mockResolvedValueOnce(
        user("active@example.org", "active-sub", "CONFIRMED"),
      )
      .mockResolvedValueOnce({
        Groups: [{ GroupName: "compliance-supervisor" }],
      })
      .mockResolvedValueOnce({});

    const response = await call(
      resetAdminUserPassword,
      event(undefined, { username: "active@example.org" }),
    );

    expect(response.statusCode).toBe(200);
    expect(cognitoSend.mock.calls[2][0]).toBeInstanceOf(
      AdminResetUserPasswordCommand,
    );
  });

  it("does not expose lifecycle actions for a non-administrator Cognito user", async () => {
    cognitoSend
      .mockResolvedValueOnce(
        user("other@example.org", "other-sub", "CONFIRMED"),
      )
      .mockResolvedValueOnce({ Groups: [] });

    const response = await call(
      resetAdminUserPassword,
      event(undefined, { username: "other@example.org" }),
    );

    expect(response.statusCode).toBe(404);
    expect(cognitoSend).toHaveBeenCalledTimes(2);
  });
});

/** @param {string} username @param {string} sub @param {string} [status] */
function user(username, sub, status = "CONFIRMED") {
  return {
    Username: username,
    Enabled: true,
    UserStatus: status,
    UserAttributes: [
      { Name: "sub", Value: sub },
      { Name: "email", Value: username },
    ],
  };
}

/**
 * @param {unknown} body
 * @param {Record<string, string>} pathParameters
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
            sub: "caller-sub",
            username: "caller@example.org",
          },
        },
      },
    },
  };
}

/** @param {Function} handler @param {Record<string, unknown>} request */
async function call(handler, request) {
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    await handler(request, {}, () => {})
  );
}
