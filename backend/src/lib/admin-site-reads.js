import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { queryAllItems } from "./query-all-items.js";

/** Read only the prefixes needed by a screen, including every DynamoDB page.
 * @param {string} siteId @param {string[]} prefixes
 */
export async function readSiteParts(siteId, prefixes) {
  const TableName = getDynamoTableName();
  const { Item } = await ddb.send(
    new GetCommand({
      TableName,
      Key: { pk: `SITE#${siteId}`, sk: "#META" },
      ConsistentRead: true,
    }),
  );
  if (!Item) return [];
  const items = [Item];
  // Sequential within each site; directory workers share a bounded budget.
  for (const prefix of prefixes) {
    const page = await queryAllItems({
      TableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `SITE#${siteId}`, ":prefix": prefix },
      ConsistentRead: true,
    });
    items.push(...page.Items);
  }
  return items;
}

/** @template T,R @param {T[]} values @param {(value:T)=>Promise<R>} work */
export async function boundedReads(values, work) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, values.length) }, async () => {
      while (next < values.length) {
        const i = next++;
        results[i] = await work(values[i]);
      }
    }),
  );
  return results;
}
