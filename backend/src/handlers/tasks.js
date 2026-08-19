import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { GSI2_NAME, taskWorklistPk } from "./keys.js";

// A task's GSI2 sort key is date-first (`${createdAt}#${kind}#${severity}#${taskId}`)
// so the index serves date-range task lists efficiently (see guidance-workflow-
// backend-plan.md § Index Tradeoffs). That gives up the index's severity ordering,
// so AP10's "most severe first" is restored by sorting the fetched page in memory.
// With a `limit`, we read the newest N descending, then re-order that bounded page
// by severity: the result is "most severe among the newest N", not "most severe
// overall" — the tradeoff the plan accepts for MVP.

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
      ...(limit ? { Limit: limit } : {}),
    }),
  );

  return jsonResponse(200, { tasks: byWorklistPriority(result.Items ?? []) });
};
