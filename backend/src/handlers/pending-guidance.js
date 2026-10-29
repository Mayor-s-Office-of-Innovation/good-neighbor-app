import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { deriveSiteId } from "../lib/principal.js";
import { jsonResponse } from "../http.js";
import { GSI1_NAME } from "./keys.js";
import { getAssessmentGuidance } from "../analysis/guidance/guidance-store.js";

/** Recover unanswered guidance from existing assessments, including older reports.
 * Each call examines a bounded timeline page; empty filtered pages retain cursors.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const listPendingGuidance = async (event) => {
  const siteId = deriveSiteId(event);
  const { dynamoTable } = getConfig();
  const partition = `SITE#${siteId}#ASSESSMENT`;
  const token = event.queryStringParameters?.nextToken;
  let cursor;
  if (token) {
    try {
      if (typeof token !== "string" || token.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(token, "base64url").toString());
      if (
        cursor.pk !== `SITE#${siteId}` ||
        cursor.gsi1pk !== partition ||
        typeof cursor.sk !== "string" ||
        !/^ASSESSMENT#[^#]+$/.test(cursor.sk) ||
        typeof cursor.gsi1sk !== "string" ||
        Object.keys(cursor).sort().join() !== "gsi1pk,gsi1sk,pk,sk"
      )
        throw new Error();
    } catch {
      return jsonResponse(400, { error: "invalid_cursor" });
    }
  }
  const page = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      IndexName: GSI1_NAME,
      KeyConditionExpression: "gsi1pk = :pk",
      FilterExpression:
        "(#status = :pending OR #status = :manual) AND attribute_not_exists(supersededByAssessmentId)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": partition,
        ":pending": "needs_answers",
        ":manual": "manual_review",
      },
      ScanIndexForward: false,
      Limit: 25,
      ExclusiveStartKey: cursor,
    }),
  );
  const guidance = [];
  for (const row of page.Items ?? []) {
    // GSI projection can lag an answer or edit. Re-read authoritative records.
    const current = await getAssessmentGuidance({
      tableName: dynamoTable,
      siteId,
      assessmentId: String(row.assessmentId),
    });
    if (!current.assessment || current.assessment.supersededByAssessmentId)
      continue;
    const conditions = [];
    for (const condition of current.conditions) {
      if (condition.status !== "needs_answer" || !condition.needsAnswer)
        continue;
      const source = /** @type {{ artifactIds?: string[] }} */ (
        condition.source
      );
      const artifactId = source?.artifactIds?.[0];
      if (artifactId) {
        const deletion = await ddb.send(
          new GetCommand({
            TableName: dynamoTable,
            Key: {
              pk: `SITE#${siteId}`,
              sk: `ISSUE_DELETION#${current.assessment.checkId}:${artifactId}:${condition.conditionId}`,
            },
            ConsistentRead: true,
          }),
        );
        if (deletion.Item?.deletedAt) continue;
      }
      conditions.push(condition);
    }
    if (conditions.length)
      guidance.push({ assessment: current.assessment, conditions });
  }
  return jsonResponse(200, {
    guidance,
    nextToken: page.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url")
      : null,
  });
};
