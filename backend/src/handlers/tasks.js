import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { GSI2_NAME, taskWorklistPk } from "./keys.js";

// A task's GSI2 sort key is `${severity}#${createdAt}`; severity is 0–4, so a
// plain string sort matches numeric order (single digit) and newest-within-
// severity falls out of the ISO timestamp. Reading descending gives the staff
// worklist its natural order: most severe first, newest first within a severity.

const DEFAULT_STATUS = "open";

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
      ScanIndexForward: false, // most-severe first, newest first within a severity
      ...(limit ? { Limit: limit } : {}),
    }),
  );

  return jsonResponse(200, { tasks: result.Items ?? [] });
};
