import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { sitePk } from "../handlers/keys.js";

const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * @param {string} instant
 * @returns {string}
 */
export function completionDay(instant) {
  const parts = Object.fromEntries(
    pacific
      .formatToParts(new Date(instant))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * @param {string} day
 * @param {number} offset
 * @returns {string}
 */
function shiftDay(day, offset) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * One immutable marker per completed perimeter check, outside CHECK# children
 * and GSI1. Canonical completion time makes retries/backfills use the same key.
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} completedAt
 * @returns {{pk: string, sk: string, checkId: string, completedAt: string}}
 */
export function checkCompletionRecord(siteId, checkId, completedAt) {
  const instant = new Date(completedAt).toISOString();
  return {
    pk: sitePk(siteId),
    sk: `CHECK_COMPLETION#${completionDay(instant)}#${instant}#${checkId}`,
    checkId,
    completedAt: instant,
  };
}

export const COMPLETION_MIGRATION_KEY = {
  pk: "SYSTEM#MIGRATIONS",
  sk: "CHECK_COMPLETIONS_V1",
};

/**
 * Read only the five Pacific completion days ending at startedAt. Base-table
 * strong reads see atomic completion writes without waiting for GSI propagation.
 * @param {Pick<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient, "send">} client
 * @param {string} tableName
 * @param {string} siteId
 * @param {string} startedAt
 * @param {string} checkId
 * @returns {Promise<number[]>} Today, yesterday, through four days ago.
 */
export async function recentCompletionCounts(
  client,
  tableName,
  siteId,
  startedAt,
  checkId,
) {
  const today = completionDay(startedAt);
  const days = Array.from({ length: 5 }, (_, index) => shiftDay(today, -index));
  const counts = [0, 0, 0, 0, 0];
  /** @type {Record<string, unknown> | undefined} */
  let startKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await client.send(
      new QueryCommand({
        TableName: tableName,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": sitePk(siteId),
          ":from": `CHECK_COMPLETION#${days[4]}#`,
          ":to": `CHECK_COMPLETION#${today}#${startedAt}#\uffff`,
        },
        ProjectionExpression: "checkId, completedAt",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      if (
        item.checkId === checkId ||
        typeof item.completedAt !== "string" ||
        item.completedAt > startedAt
      )
        continue;
      const index = days.indexOf(completionDay(item.completedAt));
      if (index >= 0) counts[index] += 1;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return counts;
}
