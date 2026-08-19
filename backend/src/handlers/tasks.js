import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { GSI2_NAME, taskWorklistPk } from "./keys.js";

// A task's GSI2 sort key is date-first (`${createdAt}#${kind}#${severity}#${taskId}`)
// so the index serves date-range task lists efficiently (see guidance-workflow-
// backend-plan.md § Index Tradeoffs). That gives up the index's severity ordering,
// so AP10's "most severe first" is restored by sorting in memory here.
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
  // task. Visible-not-silent — this is the signal to add a severity-first index
  // (guidance-workflow-backend-plan.md § Index Tradeoffs) rather than page here.
  if (result.LastEvaluatedKey) {
    console.warn(
      `listTasks: ${taskWorklistPk(siteId, status)} exceeded one page; ` +
        "severity ranking is incomplete.",
    );
  }

  const ranked = byWorklistPriority(result.Items ?? []);
  return jsonResponse(200, { tasks: limit ? ranked.slice(0, limit) : ranked });
};
