import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { GSI2_NAME, taskKey, taskWorklistPk } from "./keys.js";
import {
  createSf311Client,
  GOOD_NEIGHBOR_AGENCY,
} from "../integrations/sf311-client.js";
import {
  findServiceRequest,
  normalizeSf311Detail,
} from "../integrations/sf311-status.js";
import { activeCatalog } from "../analysis/guidance/catalog-registry.js";

// A task's GSI2 sort key is date-first (`${createdAt}#${kind}#${severity}#${taskId}`)
// so the index serves date-range task lists efficiently (see the data model doc,
// GSI2 + AP10). That gives up the index's severity ordering, so AP10's "most
// severe first" is restored by sorting in memory here.
//
// A caller `limit` is applied AFTER the sort (a slice), never as a DynamoDB Limit:
// a Limit truncates by the index order (newest-first), so the globally most-severe
// task could fall outside the page and vanish. Sorting the whole partition first,
// then slicing, returns the genuinely most-severe N. The per-site/status partition
// is small, so reading it whole is cheap — bounded only by DynamoDB's 1 MB page (see
// the LastEvaluatedKey guard below).

const DEFAULT_STATUS = "open";

/**
 * Order a worklist page most-severe first, newest first within a severity.
 * @param {Record<string, any>[]} tasks
 * @returns {Record<string, any>[]}
 */
const byWorklistPriority = (tasks) =>
  [...tasks].sort(
    (a, b) =>
      (b.severity ?? 0) - (a.severity ?? 0) ||
      String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")),
  );

/**
 * GET /v1/tasks?status=open&limit= — the site's action items at one status,
 * most-severe first (AP10). Reads GSI2 (the per-status worklist index carried
 * only by TASK items, so no filtering). `siteId` is derived server-side; the
 * client can only ever read its own site's worklist.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const listTasks = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  const status = event.queryStringParameters?.status || DEFAULT_STATUS;

  const rawLimit = Number(event.queryStringParameters?.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : undefined;

  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      IndexName: GSI2_NAME,
      KeyConditionExpression: "gsi2pk = :pk",
      ExpressionAttributeValues: { ":pk": taskWorklistPk(siteId, status) },
      ScanIndexForward: false, // newest first; severity ordering applied below
      // No DynamoDB Limit — see the header comment. `limit` is a post-sort slice.
    }),
  );

  // The partition exceeded one 1 MB page, so we did NOT read every open task: the
  // severity ranking below is over a partial set and could omit the most-severe
  // task. Visible-not-silent — if this fires, the remediation is a second task
  // index sorted severity-first (rather than overloading GSI2's sort key) or
  // real pagination; do not paper over it by paging here.
  if (result.LastEvaluatedKey) {
    console.warn(
      `listTasks: ${taskWorklistPk(siteId, status)} exceeded one page; ` +
        "severity ranking is incomplete.",
    );
  }

  const ranked = byWorklistPriority(result.Items ?? []);
  return jsonResponse(200, { tasks: limit ? ranked.slice(0, limit) : ranked });
};

const updateCache = new Map();
const UPDATE_CACHE_MS = 60_000;

/** @param {Record<string, any>} task @param {string} srNum */
function taskHasTicket(task, srNum) {
  const results = Array.isArray(task.appActionResults)
    ? task.appActionResults
    : [];
  return results.some(
    (result) =>
      result?.code === "create_311_ticket" &&
      Array.isArray(result?.payload?.tickets) &&
      result.payload.tickets.some(
        (/** @type {any} */ ticket) => String(ticket?.srNum ?? "") === srNum,
      ),
  );
}

/** @param {import("../config.js").AppConfig} config */
async function latestUpdates(config) {
  const cached = updateCache.get(GOOD_NEIGHBOR_AGENCY);
  if (cached && Date.now() - cached.at < UPDATE_CACHE_MS) return cached.body;
  const body = await createSf311Client({
    config,
  }).getLatestUpdatesBySourceAgency();
  updateCache.set(GOOD_NEIGHBOR_AGENCY, { at: Date.now(), body });
  return body;
}

/** Authenticated, site-scoped and PII-free detail for one app-created 311 request. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer} */
export const get311RequestDetail = async (event) => {
  const config = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId ?? "").trim();
  const srNum = String(event.pathParameters?.srNum ?? "").trim();
  if (!taskId || !srNum)
    return jsonResponse(400, { error: "taskId and srNum are required" });
  const result = await ddb.send(
    new GetCommand({
      TableName: config.dynamoTable,
      Key: taskKey(siteId, taskId),
    }),
  );
  const task = result.Item;
  if (!task || !taskHasTicket(task, srNum))
    return jsonResponse(404, { error: "311 request not found" });
  const body = await latestUpdates(config);
  const record = findServiceRequest(body, srNum);
  if (!record)
    return jsonResponse(404, { error: "311 request has no status data yet" });
  // Open tickets created before the response-time rubric shipped have no
  // persisted deadline. Resolve those legacy tasks by stable ruleId so the
  // current operational response window also appears on their detail view.
  const currentRule = activeCatalog().rules.find(
    (rule) => rule.ruleId === task.ruleId,
  );
  const detailTask =
    task.maxAcceptableResponseHours === undefined && currentRule
      ? {
          ...task,
          maxAcceptableResponseHours: currentRule.maxAcceptableResponseHours,
        }
      : task;
  return jsonResponse(200, {
    request: normalizeSf311Detail({ record, task: detailTask, srNum }),
  });
};
