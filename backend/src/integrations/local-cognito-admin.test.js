import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminResetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it } from "vitest";
import { LocalCognitoAdminClient } from "./local-cognito-admin.js";

describe("LocalCognitoAdminClient", () => {
  const pool = "local-admin-directory";

  it("seeds active, invited, and suspended administrators", async () => {
    const client = new LocalCognitoAdminClient();
    const managers = /** @type {any} */ (
      await client.send(
        new ListUsersInGroupCommand({
          UserPoolId: pool,
          GroupName: "compliance-manager",
        }),
      )
    );
    const supervisors = /** @type {any} */ (
      await client.send(
        new ListUsersInGroupCommand({
          UserPoolId: pool,
          GroupName: "compliance-supervisor",
        }),
      )
    );

    expect(managers.Users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ UserStatus: "CONFIRMED", Enabled: true }),
        expect.objectContaining({
          UserStatus: "FORCE_CHANGE_PASSWORD",
          Enabled: true,
        }),
      ]),
    );
    expect(supervisors.Users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Enabled: true }),
        expect.objectContaining({ Enabled: false }),
      ]),
    );
  });

  it("supports the invite and lifecycle commands used by the handlers", async () => {
    const client = new LocalCognitoAdminClient();
    const username = `new-${Date.now()}@example.org`;
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: pool,
        Username: username,
        UserAttributes: [
          { Name: "email", Value: username },
          { Name: "name", Value: "New Administrator" },
        ],
      }),
    );
    await client.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: pool,
        Username: username,
        GroupName: "compliance-manager",
      }),
    );
    expect(
      await client.send(
        new AdminListGroupsForUserCommand({
          UserPoolId: pool,
          Username: username,
        }),
      ),
    ).toMatchObject({ Groups: [{ GroupName: "compliance-manager" }] });

    await client.send(
      new AdminDisableUserCommand({ UserPoolId: pool, Username: username }),
    );
    expect(
      await client.send(
        new AdminGetUserCommand({ UserPoolId: pool, Username: username }),
      ),
    ).toMatchObject({ Enabled: false });
    await client.send(
      new AdminEnableUserCommand({ UserPoolId: pool, Username: username }),
    );
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: pool,
        Username: username,
        MessageAction: "RESEND",
      }),
    );
    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: pool,
        Username: username,
        UserAttributes: [{ Name: "email_verified", Value: "true" }],
      }),
    );
    await client.send(
      new AdminResetUserPasswordCommand({
        UserPoolId: pool,
        Username: username,
      }),
    );
    expect(
      await client.send(
        new AdminGetUserCommand({ UserPoolId: pool, Username: username }),
      ),
    ).toMatchObject({
      Enabled: true,
      UserStatus: "RESET_REQUIRED",
      UserAttributes: expect.arrayContaining([
        { Name: "email_verified", Value: "true" },
      ]),
    });
  });
});
