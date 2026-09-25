// POST /admin/v1/analytics/query — ad-hoc read-only SQL over the analytics
// lake for central admins (ADR 0013 ad-hoc leg). See analytics/query.js for
// the engine. This handler only gates (central-admin), validates the SQL
// shape, resolves the lake bucket, and wraps the query result in JSON.
import { jsonResponse } from "../http.js";
import { runQuery, toQueryResponse } from "../analytics/query.js";
import { logServerError } from "../lib/log-server-error.js";

/**
 * Resolve the analytics lake bucket. Matches how getDynamoTableName works:
 * required at use time, not at module load, so the config loads in tests and
 * in the local API where the analytics env may not be set.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function getLakeBucket(env = process.env) {
  const bucket = env.LAKE_BUCKET;
  if (!bucket) {
    throw new Error("Missing required environment variable for LAKE_BUCKET");
  }
  return bucket;
}

/** Statements that mutate state or read outside the lake's data plane. */
const BLOCKED_SQL =
  /\b(attach|detach|install|load|create\s+secret|set\s+secret|drop\s+secret|copy\s+[^;]*\bfrom\b|read_csv|read_json|parquet_scan|write_file|glob)\b/i;

/**
 * POST /admin/v1/analytics/query  body: { sql: string }
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const runAnalyticsQuery = (event) =>
  adminAnalytics(event, async (body) => {
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) return jsonResponse(400, { error: "sql_required" });
    if (sql.length > 20_000)
      return jsonResponse(400, { error: "sql_too_long" });
    if (BLOCKED_SQL.test(sql)) {
      return jsonResponse(400, { error: "sql_not_allowed" });
    }
    let result;
    try {
      result = await runQuery(getLakeBucket(), sql);
    } catch (err) {
      // Log the detail server-side only; the response carries a generic error
      // so internals (bucket names, SQL fragments, engine messages) don't leak
      // back to the caller.
      logServerError("admin-analytics", /** @type {Error} */ (err), {
        extra: { sqlLength: sql.length },
      });
      return jsonResponse(502, { error: "query_failed" });
    }
    return jsonResponse(200, toQueryResponse(result));
  });

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {(body: Record<string, unknown>) => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function adminAnalytics(event, fn) {
  const authorizer =
    /** @type {any} */ (event.requestContext)?.authorizer ?? {};
  const groups =
    authorizer.jwt?.claims?.["cognito:groups"] ??
    authorizer["claims.cognito:groups"] ??
    "";
  let groupList = /** @type {string[]} */ ([]);
  if (Array.isArray(groups)) {
    groupList = groups;
  } else if (typeof groups === "string") {
    const value = groups.trim();
    if (value.startsWith("[")) {
      if (!value.endsWith("]"))
        return jsonResponse(403, { error: "forbidden" });
      try {
        const parsed = JSON.parse(value);
        groupList = Array.isArray(parsed) ? parsed : [];
      } catch {
        // HTTP API JWT claims can stringify a group list without JSON quotes.
        // Match whole comma-delimited names, never substrings.
        groupList = value
          .slice(1, -1)
          .split(",")
          .map((g) => g.trim());
      }
    } else {
      groupList = value.split(",").map((g) => g.trim());
    }
  }
  if (!groupList.includes("central-admin")) {
    return jsonResponse(403, { error: "forbidden" });
  }
  let body = /** @type {Record<string, unknown>} */ ({});
  if (event.body) {
    try {
      body = JSON.parse(
        event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body,
      );
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
  }
  return fn(body);
}
