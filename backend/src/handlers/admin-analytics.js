// Admin analytics endpoints (ADR 0013 ad-hoc leg) — read-only queries over
// the analytics lake for central admins. See analytics/query.js for the
// engine and its lockdown and analytics/catalog.js for the canned queries;
// this handler only gates (central-admin), validates the request shape,
// resolves the lake bucket, and shapes the JSON response.
//
// Routes (served by the dedicated analytics-query Lambda, never the app api):
//   GET  /admin/v1/analytics/queries              the catalog
//   POST /admin/v1/analytics/queries/{queryId}    run one, body { params }
//   POST /admin/v1/analytics/query                raw SQL, body { sql }
import { jsonResponse } from "../http.js";
import { adminOnly } from "../lib/admin-auth.js";
import { QueryError, runQuery, toQueryResponse } from "../analytics/query.js";
import {
  ParamError,
  bindParams,
  getQuery,
  listCatalog,
} from "../analytics/catalog.js";
import { logServerError } from "../lib/log-server-error.js";

/**
 * Resolve the analytics lake bucket. Required at use time, not at module
 * load, so the module loads in tests and in the local API where the
 * analytics env may not be set.
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

export const MAX_SQL_LENGTH = 20_000;

/**
 * GET /admin/v1/analytics/queries — the canned query catalog.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const listAnalyticsQueries = (event) =>
  adminOnly(event, async () => jsonResponse(200, { queries: listCatalog() }));

/**
 * POST /admin/v1/analytics/queries/{queryId}  body: { params?: object }
 *
 * Runs one catalog query with validated, prepared-statement-bound
 * parameters.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const runAnalyticsCatalogQuery = (event) =>
  adminOnly(event, async (body) => {
    const queryId = event.pathParameters?.queryId ?? "";
    const query = getQuery(queryId);
    if (!query) return jsonResponse(404, { error: "query_not_found" });
    let params;
    try {
      params = bindParams(query, body.params);
    } catch (err) {
      if (err instanceof ParamError) {
        return jsonResponse(400, {
          error: "params_invalid",
          message: err.message,
        });
      }
      throw err;
    }
    return respond(() => runQuery(getLakeBucket(), query.sql, params), {
      queryId,
    });
  });

/**
 * POST /admin/v1/analytics/query  body: { sql: string }
 *
 * Raw SQL for central admins (the "advanced" leg). Statement shape and
 * filesystem/config access are enforced by the engine, not here.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const runAnalyticsQuery = (event) =>
  adminOnly(event, async (body) => {
    const sql = typeof body.sql === "string" ? body.sql.trim() : "";
    if (!sql) return jsonResponse(400, { error: "sql_required" });
    if (sql.length > MAX_SQL_LENGTH)
      return jsonResponse(400, { error: "sql_too_long" });
    return respond(() => runQuery(getLakeBucket(), sql), {
      sqlLength: sql.length,
    });
  });

/**
 * Run a query and map its outcome to an HTTP response. User errors (the
 * caller's SQL) are echoed back as 400 so the admin can fix the statement;
 * engine errors are logged server-side and returned as a generic 502 so
 * internals (bucket names, S3 paths, extension state) don't leak.
 * @param {() => Promise<import("../analytics/query.js").QueryResult>} work
 * @param {Record<string, unknown>} logExtra
 * @returns {Promise<any>}
 */
async function respond(work, logExtra = {}) {
  try {
    return jsonResponse(200, toQueryResponse(await work()));
  } catch (err) {
    if (err instanceof QueryError && err.kind === "user") {
      return jsonResponse(400, { error: "sql_invalid", message: err.message });
    }
    logServerError("admin-analytics", /** @type {Error} */ (err), {
      extra: logExtra,
    });
    return jsonResponse(502, { error: "query_failed" });
  }
}
