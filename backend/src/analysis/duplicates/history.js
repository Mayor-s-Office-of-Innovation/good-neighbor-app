import { QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { analysisRevision, projectionKey } from "./jobs.js";
/** Bootstrap metadata only when the isolated worker finds a coverage gap. Never loads media or calls analysis.
 * @param {string} table @param {string} site @param {string} from
 */
export async function ensureDuplicateHistory(table, site, from) {
  const pk = `SITE#${site}`;
  /** @type {Record<string,any>[]} */ const rows = [];
  let cursor;
  do {
    /** @type {import('@aws-sdk/lib-dynamodb').QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "CHECK#" },
        ExclusiveStartKey: cursor,
      }),
    );
    rows.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const map = new Map(rows.map((row) => [row.sk, row]));
  for (const analysis of rows) {
    if (
      !/^CHECK#[^#]+#ANALYSIS#[^#]+$/.test(analysis.sk) ||
      analysis.status !== "analyzed"
    )
      continue;
    const time = analysis.generatedAt ?? analysis.analyzedAt;
    if (!Number.isFinite(Date.parse(time)) || time < from) continue;
    const artifact = map.get(analysis.sk.replace("#ANALYSIS#", "#ART#"));
    if (!artifact) continue;
    const checkId = analysis.sk.split("#")[1],
      artifactId = analysis.sk.split("#")[3],
      id = `${checkId}:${artifactId}`;
    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...projectionKey(site, time, id),
            id,
            siteId: site,
            sourceId: id,
            checkId,
            artifactId,
            revision: analysisRevision(analysis),
            observedAt: time,
            availableAt: analysis.analyzedAt,
            ...(artifact.capturedAt ? { capturedAt: artifact.capturedAt } : {}),
            ...(artifact.s3Key
              ? { s3Key: artifact.s3Key, contentType: artifact.contentType }
              : {}),
            conditions: (analysis.concerns ?? [])
              .filter((/** @type {any} */ c) => c.rating > 0 && c.conditionId)
              .map((/** @type {any} */ c) => ({
                id: c.conditionId,
                category: c.category,
                description: c.explanation,
              })),
          },
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
    }
  }
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          pk,
          sk: "DUP_COVERAGE",
          coverageFrom: from,
          updatedAt: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(sk) OR coverageFrom > :from",
        ExpressionAttributeValues: { ":from": from },
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "ConditionalCheckFailedException"
    )
      throw error;
  }
}
