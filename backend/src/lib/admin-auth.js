// Central-admin gate shared by every /admin/v1/* handler. The admin JWT
// authorizer (api.tf) injects Cognito claims; HTTP API stringifies the
// `cognito:groups` list in more than one shape, so membership is matched on
// whole group names in every shape rather than by substring.
import { jsonResponse, readJsonBody } from "../http.js";

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {boolean}
 */
export function isCentralAdmin(event) {
  const authorizer =
    /** @type {any} */ (event.requestContext)?.authorizer ?? {};
  const groups =
    authorizer.jwt?.claims?.["cognito:groups"] ??
    authorizer["claims.cognito:groups"] ??
    "";
  if (Array.isArray(groups)) return groups.includes("central-admin");
  if (typeof groups !== "string") return false;
  const value = groups.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) return false;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.includes("central-admin");
    } catch {
      // HTTP API JWT claims can stringify a group list without JSON quotes.
      // Match whole comma-delimited names, never substrings or words in a name.
      return value
        .slice(1, -1)
        .split(",")
        .some((group) => group.trim() === "central-admin");
    }
  }
  return value.split(",").some((group) => group.trim() === "central-admin");
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
