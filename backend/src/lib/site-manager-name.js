import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";

/** Resolve the current name without exposing directory contact details.
 * Legacy sites without an ID, or with a missing directory entry, retain their snapshot.
 * @param {Record<string, any>} oversight
 */
export async function currentManagerOversight(oversight = {}) {
  if (!oversight.cityProgramManagerId) return oversight;
  /** @type {Record<string, any> | undefined} */
  let cursor;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": "ADMIN_DIRECTORY#PROGRAM_MANAGERS",
        },
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }),
    );
    const manager = result.Items?.find(
      (item) => item.userId === oversight.cityProgramManagerId,
    );
    if (manager) {
      const name =
        [manager.firstName, manager.lastName].filter(Boolean).join(" ") ||
        manager.name;
      return name ? { ...oversight, cityProgramManager: name } : oversight;
    }
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return oversight;
}
