import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export const DUPLICATE_UI_ROLLOUT_KEY = {
  pk: "MIGRATION#DUPLICATE_UI_V1",
  sk: "#META",
};

/**
 * One-time, resumable rollout for existing Sites. A per-Site marker prevents
 * partial retries from undoing an operator's explicit rollback. An environment
 * completion marker excludes future Sites from this rollout. Concurrent
 * settings edits fail the deployment rather than overwriting another flag.
 * @param {Pick<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient, "send">} client
 * @param {string} tableName
 * @param {boolean} [apply]
 */
export async function enableDuplicateUi(client, tableName, apply = false) {
  const completed = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: DUPLICATE_UI_ROLLOUT_KEY,
      ConsistentRead: true,
    }),
  );
  if (completed.Item?.completed === true) return { eligible: 0, written: 0 };
  let eligible = 0;
  let written = 0;
  /** @type {Record<string, any> | undefined} */
  let cursor;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").ScanCommandOutput} */
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        FilterExpression:
          "begins_with(pk, :site) AND sk = :meta AND attribute_not_exists(duplicateUiRolloutVersion)",
        ExpressionAttributeValues: { ":site": "SITE#", ":meta": "#META" },
        ProjectionExpression: "pk, sk, featureFlags",
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of page.Items ?? []) {
      eligible++;
      if (!apply) continue;
      const hasFlags = Object.hasOwn(item, "featureFlags");
      const flags =
        item.featureFlags && typeof item.featureFlags === "object"
          ? item.featureFlags
          : {};
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression:
            "SET featureFlags = :flags, duplicateUiRolloutVersion = :version",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_not_exists(duplicateUiRolloutVersion) AND " +
            (hasFlags
              ? "featureFlags = :prior"
              : "attribute_not_exists(featureFlags)"),
          ExpressionAttributeValues: {
            ":flags": { ...flags, duplicateDetection: true },
            ":version": 1,
            ...(hasFlags ? { ":prior": item.featureFlags } : {}),
          },
        }),
      );
      written++;
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  // Only a fully successful apply closes the rollout. Dry runs and partial
  // failures must remain resumable; future Sites inherit the API default.
  if (apply)
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...DUPLICATE_UI_ROLLOUT_KEY, completed: true },
      }),
    );
  return { eligible, written };
}
