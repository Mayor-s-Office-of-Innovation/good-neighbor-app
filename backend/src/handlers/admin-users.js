import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  AdminListGroupsForUserCommand,
  ListUsersInGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomUUID } from "node:crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getConfig, getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import {
  ADMIN_GROUPS,
  adminOnly,
  adminPrincipal,
  supervisorOnly,
} from "../lib/admin-auth.js";

const cognito = new CognitoIdentityProviderClient({});
const ROLES = [ADMIN_GROUPS.manager, ADMIN_GROUPS.supervisor];
const ADMIN_GROUP_SET = new Set([...ROLES, ADMIN_GROUPS.legacyManager]);
const SUPERVISOR_MUTATION_LOCK = {
  pk: "ADMIN_LOCK#SUPERVISOR_MUTATION",
  sk: "#LOCK",
};
const LOCK_SECONDS = 30;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getAdminSession = (event) =>
  adminOnly(event, async () => {
    const principal = adminPrincipal(event);
    return jsonResponse(200, {
      role: principal.role,
      capabilities: principal.capabilities,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listAdminUsers = (event) =>
  supervisorOnly(event, async () => {
    const pool = configuredPool();
    if (!pool) return unavailable();
    const [managers, supervisors, legacyManagers] = await Promise.all([
      usersInGroup(pool, ADMIN_GROUPS.manager),
      usersInGroup(pool, ADMIN_GROUPS.supervisor),
      usersInGroup(pool, ADMIN_GROUPS.legacyManager),
    ]);
    const users = new Map();
    /** @type {Array<[string, import("@aws-sdk/client-cognito-identity-provider").UserType[]]>} */
    const byRole = [
      [ADMIN_GROUPS.manager, [...legacyManagers, ...managers]],
      [ADMIN_GROUPS.supervisor, supervisors],
    ];
    for (const [role, entries] of byRole) {
      for (const user of entries) {
        const current = users.get(user.Username);
        users.set(
          user.Username,
          publicUser(
            user,
            current?.role === ADMIN_GROUPS.supervisor ? current.role : role,
          ),
        );
      }
    }
    return jsonResponse(200, {
      users: [...users.values()].sort((a, b) => a.email.localeCompare(b.email)),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const inviteAdminUser = (event) =>
  supervisorOnly(event, async (body) => {
    const pool = configuredPool();
    if (!pool) return unavailable();
    const email = clean(body.email).toLowerCase();
    const firstName = clean(body.firstName);
    const lastName = clean(body.lastName);
    const role = clean(body.role);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return jsonResponse(400, { error: "valid_email_required" });
    if (!firstName || !lastName)
      return jsonResponse(400, { error: "name_required" });
    if (!(/** @type {string[]} */ (ROLES).includes(role)))
      return jsonResponse(400, { error: "invalid_role" });
    let created = false;
    let existingUser;
    try {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: pool,
          Username: email,
          DesiredDeliveryMediums: ["EMAIL"],
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "given_name", Value: firstName },
            { Name: "family_name", Value: lastName },
            { Name: "name", Value: `${firstName} ${lastName}` },
          ],
        }),
      );
      created = true;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "UsernameExistsException")
        throw error;
      existingUser = await getUser(pool, email);
      const existingGroups = await groupsForUser(pool, email);
      if (existingUser.Enabled === false || existingGroups.length > 0)
        return jsonResponse(409, { error: "admin_user_exists" });
    }
    try {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: pool,
          Username: email,
          GroupName: role,
        }),
      );
    } catch {
      let rollback = "not_applicable";
      if (created) {
        try {
          await cognito.send(
            new AdminDeleteUserCommand({
              UserPoolId: pool,
              Username: email,
            }),
          );
          rollback = "completed";
        } catch (rollbackError) {
          rollback = "failed";
          console.error("Failed to roll back ungrouped Cognito user", {
            username: email,
            error: rollbackError,
          });
        }
      }
      return jsonResponse(502, {
        error: "admin_group_assignment_failed",
        rollback,
      });
    }
    const user = existingUser ?? (await getUser(pool, email));
    return jsonResponse(201, { user: publicUser(user, role) });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateAdminUserRole = (event) =>
  supervisorOnly(event, async (body) => {
    const pool = configuredPool();
    if (!pool) return unavailable();
    const username = decodeURIComponent(event.pathParameters?.username ?? "");
    const role = clean(body.role);
    if (!username || !(/** @type {string[]} */ (ROLES).includes(role)))
      return jsonResponse(400, { error: "invalid_role" });
    return withSupervisorMutationLock(async () => {
      const target = await getUser(pool, username);
      const principal = adminPrincipal(event);
      if (sameUser(principal, target) && role !== ADMIN_GROUPS.supervisor)
        return jsonResponse(409, { error: "cannot_demote_self" });
      if (
        role !== ADMIN_GROUPS.supervisor &&
        (await isLastEnabledSupervisor(pool, target))
      )
        return jsonResponse(409, { error: "last_active_supervisor" });
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: pool,
          Username: username,
          GroupName: role,
        }),
      );
      const cleanupFailures = [];
      for (const group of ADMIN_GROUP_SET) {
        if (group === role) continue;
        try {
          await cognito.send(
            new AdminRemoveUserFromGroupCommand({
              UserPoolId: pool,
              Username: username,
              GroupName: group,
            }),
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== "ResourceNotFoundException"
          ) {
            cleanupFailures.push(group);
          }
        }
      }
      return jsonResponse(200, {
        user: publicUser(target, role),
        ...(cleanupFailures.length
          ? { warning: "role_cleanup_incomplete", cleanupFailures }
          : {}),
      });
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const suspendAdminUser = (event) =>
  supervisorOnly(event, async () => setEnabled(event, false));

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const reinstateAdminUser = (event) =>
  supervisorOnly(event, async () => setEnabled(event, true));

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event @param {boolean} enabled */
async function setEnabled(event, enabled) {
  const pool = configuredPool();
  if (!pool) return unavailable();
  const username = decodeURIComponent(event.pathParameters?.username ?? "");
  if (!username) return jsonResponse(400, { error: "username_required" });
  const changeEnabled = async () => {
    const target = await getUser(pool, username);
    const principal = adminPrincipal(event);
    if (!enabled && sameUser(principal, target))
      return jsonResponse(409, { error: "cannot_suspend_self" });
    if (!enabled && (await isLastEnabledSupervisor(pool, target)))
      return jsonResponse(409, { error: "last_active_supervisor" });
    const Command = enabled ? AdminEnableUserCommand : AdminDisableUserCommand;
    await cognito.send(new Command({ UserPoolId: pool, Username: username }));
    return jsonResponse(200, {
      user: { ...publicUser(target, ""), enabled },
    });
  };
  return enabled ? changeEnabled() : withSupervisorMutationLock(changeEnabled);
}

/**
 * Serialize changes that could remove the final active supervisor.
 * @param {() => Promise<import("aws-lambda").APIGatewayProxyStructuredResultV2>} fn
 */
async function withSupervisorMutationLock(fn) {
  const token = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await ddb.send(
      new PutCommand({
        TableName: getDynamoTableName(),
        Item: {
          ...SUPERVISOR_MUTATION_LOCK,
          type: "adminMutationLock",
          token,
          expiresAt: now + LOCK_SECONDS,
        },
        ConditionExpression:
          "attribute_not_exists(pk) OR expiresAt < :currentTime",
        ExpressionAttributeValues: { ":currentTime": now },
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return jsonResponse(409, { error: "admin_user_change_in_progress" });
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: getDynamoTableName(),
          Key: SUPERVISOR_MUTATION_LOCK,
          ConditionExpression: "token = :token",
          ExpressionAttributeValues: { ":token": token },
        }),
      );
    } catch (error) {
      console.error("Failed to release supervisor mutation lock", { error });
    }
  }
}

/** @param {string} pool @param {any} target */
async function isLastEnabledSupervisor(pool, target) {
  if (target.Enabled === false) return false;
  const supervisors = await usersInGroup(pool, ADMIN_GROUPS.supervisor);
  const targetSub = attributes(target).sub;
  if (!supervisors.some((user) => attributes(user).sub === targetSub))
    return false;
  return supervisors.filter((user) => user.Enabled !== false).length <= 1;
}

/** @param {string} pool @param {string} group @returns {Promise<import("@aws-sdk/client-cognito-identity-provider").UserType[]>} */
async function usersInGroup(pool, group) {
  /** @type {import("@aws-sdk/client-cognito-identity-provider").UserType[]} */
  const users = [];
  let NextToken;
  do {
    const result =
      /** @type {import("@aws-sdk/client-cognito-identity-provider").ListUsersInGroupCommandOutput} */ (
        await cognito.send(
          new ListUsersInGroupCommand({
            UserPoolId: pool,
            GroupName: group,
            ...(NextToken ? { NextToken } : {}),
          }),
        )
      );
    users.push(...(result.Users ?? []));
    NextToken = result.NextToken;
  } while (NextToken);
  return users;
}

/** @param {string} pool @param {string} username */
async function groupsForUser(pool, username) {
  const result = await cognito.send(
    new AdminListGroupsForUserCommand({
      UserPoolId: pool,
      Username: username,
    }),
  );
  return (result.Groups ?? [])
    .map((group) => group.GroupName ?? "")
    .filter(Boolean);
}

/** @param {string} pool @param {string} username */
async function getUser(pool, username) {
  return cognito.send(
    new AdminGetUserCommand({ UserPoolId: pool, Username: username }),
  );
}

/** @param {any} user @param {string} role */
function publicUser(user, role) {
  const attrs = attributes(user);
  return {
    username: user.Username ?? "",
    subject: attrs.sub ?? "",
    email: attrs.email ?? user.Username ?? "",
    name:
      attrs.name ??
      [attrs.given_name, attrs.family_name].filter(Boolean).join(" ") ??
      "",
    role,
    enabled: user.Enabled !== false,
    status: user.UserStatus ?? "",
  };
}

/** @param {any} user @returns {Record<string, string>} */
function attributes(user) {
  return Object.fromEntries(
    (user.UserAttributes ?? user.Attributes ?? []).map(
      (/** @type {any} */ attribute) => [attribute.Name, attribute.Value],
    ),
  );
}

/** @param {ReturnType<typeof adminPrincipal>} principal @param {any} target */
function sameUser(principal, target) {
  const attrs = attributes(target);
  return Boolean(
    (principal.subject && principal.subject === attrs.sub) ||
      (principal.username && principal.username === target.Username),
  );
}

function configuredPool() {
  return getConfig().cognitoUserPoolId;
}

function unavailable() {
  return jsonResponse(503, { error: "cognito_not_configured" });
}

/** @param {unknown} value */
function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}
