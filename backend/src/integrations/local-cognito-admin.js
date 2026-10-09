import { randomUUID } from "node:crypto";

const GROUPS = {
  manager: "compliance-manager",
  supervisor: "compliance-supervisor",
};

/** @typedef {{ username: string, enabled: boolean, status: string, attributes: Record<string, string>, groups: Set<string>, createdAt: Date, updatedAt: Date }} LocalUser */

/** @type {Map<string, LocalUser>} */
const users = new Map(
  [
    seedUser("local-admin", "Local", "Supervisor", GROUPS.supervisor),
    seedUser("maya.manager@example.org", "Maya", "Manager", GROUPS.manager),
    seedUser(
      "invited.manager@example.org",
      "Invited",
      "Manager",
      GROUPS.manager,
      "FORCE_CHANGE_PASSWORD",
    ),
    seedUser(
      "suspended.supervisor@example.org",
      "Suspended",
      "Supervisor",
      GROUPS.supervisor,
      "CONFIRMED",
      false,
    ),
  ].map((user) => [user.username, user]),
);

/** Minimal in-memory implementation selected only by the local API harness. */
export class LocalCognitoAdminClient {
  /** @param {{ constructor: { name: string }, input: Record<string, any> }} command */
  async send(command) {
    const { input } = command;
    const username = String(input.Username ?? "").toLowerCase();
    switch (command.constructor.name) {
      case "ListUsersInGroupCommand":
        return {
          Users: [...users.values()]
            .filter((user) => user.groups.has(input.GroupName))
            .map(listUser),
        };
      case "AdminGetUserCommand":
        return adminUser(requireUser(username));
      case "AdminListGroupsForUserCommand":
        return {
          Groups: [...requireUser(username).groups].map((GroupName) => ({
            GroupName,
          })),
        };
      case "AdminCreateUserCommand": {
        const existing = users.get(username);
        if (input.MessageAction === "RESEND") {
          const user = requireUser(username);
          if (user.status !== "FORCE_CHANGE_PASSWORD")
            throw namedError("InvalidParameterException");
          user.updatedAt = new Date();
          return { User: listUser(user) };
        }
        if (existing) throw namedError("UsernameExistsException");
        const attributes = Object.fromEntries(
          (input.UserAttributes ?? []).map(
            (
              /** @type {{ Name: string, Value: string }} */ { Name, Value },
            ) => [Name, Value],
          ),
        );
        const now = new Date();
        const user = {
          username,
          enabled: true,
          status: "FORCE_CHANGE_PASSWORD",
          attributes: { sub: randomUUID(), ...attributes },
          groups: new Set(),
          createdAt: now,
          updatedAt: now,
        };
        users.set(username, user);
        return { User: listUser(user) };
      }
      case "AdminAddUserToGroupCommand":
        requireUser(username).groups.add(input.GroupName);
        return {};
      case "AdminRemoveUserFromGroupCommand":
        requireUser(username).groups.delete(input.GroupName);
        return {};
      case "AdminDisableUserCommand":
        requireUser(username).enabled = false;
        return {};
      case "AdminEnableUserCommand":
        requireUser(username).enabled = true;
        return {};
      case "AdminDeleteUserCommand":
        users.delete(username);
        return {};
      case "AdminResetUserPasswordCommand":
        requireUser(username).status = "RESET_REQUIRED";
        return {};
      default:
        throw new Error(
          `Unsupported local Cognito command: ${command.constructor.name}`,
        );
    }
  }
}

/** @param {string} username */
function requireUser(username) {
  const user = users.get(username);
  if (!user) throw namedError("UserNotFoundException");
  user.updatedAt = new Date();
  return user;
}

/** @param {LocalUser} user */
function listUser(user) {
  return {
    Username: user.username,
    Enabled: user.enabled,
    UserStatus: user.status,
    UserCreateDate: user.createdAt,
    UserLastModifiedDate: user.updatedAt,
    Attributes: attributeList(user.attributes),
  };
}

/** @param {LocalUser} user */
function adminUser(user) {
  const { Attributes, ...result } = listUser(user);
  return { ...result, UserAttributes: Attributes };
}

/** @param {Record<string, string>} attributes */
function attributeList(attributes) {
  return Object.entries(attributes).map(([Name, Value]) => ({ Name, Value }));
}

/**
 * @param {string} username
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} role
 * @param {string} [status]
 * @param {boolean} [enabled]
 * @returns {LocalUser}
 */
function seedUser(
  username,
  firstName,
  lastName,
  role,
  status = "CONFIRMED",
  enabled = true,
) {
  const now = new Date();
  return {
    username,
    enabled,
    status,
    attributes: {
      sub: username === "local-admin" ? "local-admin" : randomUUID(),
      email: username.includes("@") ? username : "local.supervisor@example.org",
      given_name: firstName,
      family_name: lastName,
      name: `${firstName} ${lastName}`,
    },
    groups: new Set([role]),
    createdAt: now,
    updatedAt: now,
  };
}

/** @param {string} name */
function namedError(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}
