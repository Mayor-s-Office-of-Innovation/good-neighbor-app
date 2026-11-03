import { getConfig } from "../config.js";
import { jsonResponse, parseLimit } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { logServerError } from "../lib/log-server-error.js";
import { loadChecks } from "./checks.js";
import { loadTaskWorklist } from "./tasks.js";

// Home is the one screen that fires several API requests at the same instant:
// checks plus a worklist per status, every one a short DynamoDB read. Lambda
// gives each in-flight request its own execution environment, so a Home load
// used to occupy as many environments (and cold starts) as it had overlapping
// requests. This route runs the same reads side by side inside one invocation
// and answers per section, so one failed query degrades one list, not the page.
// The individual routes stay for targeted refreshes after an action.

/** The worklist statuses Home shows, in tab order. */
export const HOME_TASK_STATUSES = /** @type {const} */ ([
  "open",
  "in_progress",
  "completing",
  "completed",
]);
const DEFAULT_CHECKS_LIMIT = 30;
const DEFAULT_TASKS_LIMIT = 50;

/**
 * @typedef {{ ok: true, items: Record<string, any>[], nextToken?: string } | { ok: false, error: string }} HomeSection
 */

/**
 * A short, non-sensitive label for a failed section: the error's class name,
 * which for the SDK is the DynamoDB exception (`ProvisionedThroughputExceeded
 * Exception`, `TimeoutError`, …). The full error goes to the server log.
 * @param {unknown} reason
 * @returns {string}
 */
function errorLabel(reason) {
  return reason instanceof Error && reason.name ? reason.name : "Error";
}

/**
 * GET /v1/home?checksLimit=30&tasksLimit=50 — the Home worklist in one body:
 *
 *   { checks: { ok, items, nextToken? },
 *     tasks: { open: { ok, items }, in_progress: …, completing: …, completed: … },
 *     loadedAt }
 *
 * Each section carries its own `ok`; a rejected read is logged and reported as
 * `{ ok: false, error }` while the others still return. Only when every read
 * fails does the handler throw, so a DynamoDB outage still surfaces as the 5xx
 * the client's connection-failure path expects. `siteId` comes from the device
 * token, never the query string, exactly as on the routes this replaces.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getHome = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const query = event.queryStringParameters ?? {};
  const checksLimit = parseLimit(query.checksLimit) ?? DEFAULT_CHECKS_LIMIT;
  const tasksLimit = parseLimit(query.tasksLimit) ?? DEFAULT_TASKS_LIMIT;

  const [checksResult, ...taskResults] = await Promise.allSettled([
    loadChecks(dynamoTable, siteId, { limit: checksLimit }),
    ...HOME_TASK_STATUSES.map((status) =>
      loadTaskWorklist(dynamoTable, siteId, status, tasksLimit),
    ),
  ]);

  const settled = [checksResult, ...taskResults];
  if (settled.every((result) => result.status === "rejected")) {
    // Nothing to show: let the router's error logging and the platform 500
    // handle it the way a failed single-list read is handled today.
    throw /** @type {PromiseRejectedResult} */ (checksResult).reason;
  }

  const reqId = /** @type {any} */ (event).requestContext?.requestId;
  /**
   * @template T
   * @param {string} name
   * @param {PromiseSettledResult<T>} result
   * @param {(value: T) => Omit<Extract<HomeSection, { ok: true }>, "ok">} shape
   * @returns {HomeSection}
   */
  const section = (name, result, shape) => {
    if (result.status === "fulfilled")
      return { ok: true, ...shape(result.value) };
    logServerError(`api GET /v1/home ${name}`, result.reason, { reqId });
    return { ok: false, error: errorLabel(result.reason) };
  };

  return jsonResponse(200, {
    checks: section("checks", checksResult, ({ checks, nextToken }) => ({
      items: checks,
      ...(nextToken ? { nextToken } : {}),
    })),
    tasks: Object.fromEntries(
      HOME_TASK_STATUSES.map((status, i) => [
        status,
        section(`tasks.${status}`, taskResults[i], (items) => ({ items })),
      ]),
    ),
    loadedAt: new Date().toISOString(),
  });
};
