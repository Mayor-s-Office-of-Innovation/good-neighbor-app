import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";

export const ADMIN_GROUPS = Object.freeze({
  manager: "compliance-manager",
  supervisor: "compliance-supervisor",
  legacyManager: "central-admin",
});

const SUPERVISOR_CAPABILITIES = Object.freeze({
  manageAdminUsers: true,
  createEntities: true,
  deactivateEntities: true,
  changeLeadProgram: true,
  manageSiteManagers: true,
  runImports: true,
});
const MANAGER_CAPABILITIES = Object.freeze({
  manageAdminUsers: false,
  createEntities: false,
  deactivateEntities: false,
  changeLeadProgram: false,
  manageSiteManagers: false,
  runImports: false,
});

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
export function adminPrincipal(event) {
  const claims = /** @type {Record<string, any>} */ (
    /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims ??
      /** @type {any} */ (event.requestContext)?.authorizer ??
      {}
  );
  const groups = parseGroups(
    claims["cognito:groups"] ?? claims["claims.cognito:groups"] ?? "",
  );
  const supervisor = groups.includes(ADMIN_GROUPS.supervisor);
  const manager =
    supervisor ||
    groups.includes(ADMIN_GROUPS.manager) ||
    groups.includes(ADMIN_GROUPS.legacyManager);
  return {
    authenticated: manager,
    role: supervisor
      ? ADMIN_GROUPS.supervisor
      : manager
        ? ADMIN_GROUPS.manager
        : "",
    groups,
    subject: String(claims.sub ?? ""),
    username: String(claims["cognito:username"] ?? claims.username ?? ""),
    email: String(claims.email ?? "")
      .trim()
      .toLocaleLowerCase("en-US"),
    firstName: String(claims.given_name ?? "").trim(),
    lastName: String(claims.family_name ?? "").trim(),
    phone: String(claims.phone_number ?? "").trim(),
    department: String(claims["custom:department"] ?? "").trim(),
    capabilities: supervisor ? SUPERVISOR_CAPABILITIES : MANAGER_CAPABILITIES,
  };
}

/** @param {unknown} raw */
function parseGroups(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  const value = raw.trim();
  if (!value) return [];
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return value
        .slice(1, -1)
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean);
    }
  }
  return value
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
}

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {boolean}
 */
export function isCentralAdmin(event) {
  return adminPrincipal(event).authenticated;
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
export function isComplianceSupervisor(event) {
  return adminPrincipal(event).role === ADMIN_GROUPS.supervisor;
}

/**
 * Run `fn` with the parsed JSON body when the caller is a central admin;
 * 403 otherwise, 400 on a malformed body.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {(body: Record<string, unknown>) => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function adminOnly(event, fn) {
  if (!isCentralAdmin(event)) return jsonResponse(403, { error: "forbidden" });
  return withBody(event, fn);
}

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {(body: Record<string, unknown>) => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function supervisorOnly(event, fn) {
  if (!isComplianceSupervisor(event))
    return jsonResponse(403, { error: "supervisor_required" });
  return withBody(event, fn);
}

/**
 * Allow supervisors to administer every Site and Compliance managers only
 * Sites to which their directory identity is actively assigned.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {string} siteId
 * @param {(body: Record<string, unknown>) => Promise<any>} fn
 */
export async function siteAdminOnly(event, siteId, fn) {
  const principal = adminPrincipal(event);
  if (!principal.authenticated) {
    return jsonResponse(403, { error: "forbidden" });
  }
  if (principal.role === ADMIN_GROUPS.supervisor) return withBody(event, fn);
  const email = (principal.email || principal.username)
    .trim()
    .toLocaleLowerCase("en-US");
  if (!email) return jsonResponse(403, { error: "site_assignment_required" });
  const directory = await ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key: {
        pk: "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
        sk: `MANAGER#${email}`,
      },
      ConsistentRead: true,
    }),
  );
  if (!directory.Item?.userId) {
    return jsonResponse(403, { error: "site_assignment_required" });
  }
  const assignment = await ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key: {
        pk: `SITE#${siteId}`,
        sk: `COMPLIANCE_MANAGER#${directory.Item.userId}`,
      },
      ConsistentRead: true,
    }),
  );
  if (!assignment.Item || assignment.Item.status !== "active") {
    return jsonResponse(403, { error: "site_assignment_required" });
  }
  return withBody(event, fn);
}

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {(body: Record<string, unknown>) => Promise<any>} fn
 */
async function withBody(event, fn) {
  let body = /** @type {Record<string, unknown>} */ ({});
  if (event.body) {
    try {
      body = /** @type {Record<string, unknown>} */ (readJsonBody(event));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
  }
  return fn(body);
}
