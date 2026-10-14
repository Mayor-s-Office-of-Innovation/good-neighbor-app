import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { checkHeaderKey } from "../handlers/keys.js";
import {
  checkCompletionRecord,
  COMPLETION_MIGRATION_KEY,
} from "./check-completions.js";

/**
 * One-time resumable migration. Concurrent completions create their own markers;
 * the immutable completed header is checked atomically when migrating old rows.
 * A partial failure never marks an uninitialized migration ready.
 * @param {Pick<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient, "send">} client
 * @param {string} tableName
 * @param {boolean} [apply]
 * @returns {Promise<{eligible: number, written: number, skipped: number}>}
 */
export async function backfillCheckCompletions(
  client,
  tableName,
  apply = false,
) {
  if (apply) {
    const readiness = await client.send(
      new GetCommand({
        TableName: tableName,
        Key: COMPLETION_MIGRATION_KEY,
        ConsistentRead: true,
        ProjectionExpression: "#status",
        ExpressionAttributeNames: { "#status": "status" },
      }),
    );
    if (readiness.Item?.status === "ready") {
      return { eligible: 0, written: 0, skipped: 0 };
    }
  }

  let eligible = 0;
  let written = 0;
  let skipped = 0;
  /** @type {Record<string, unknown> | undefined} */
  let startKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").ScanCommandOutput} */
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ConsistentRead: true,
        FilterExpression:
          "begins_with(pk, :site) AND begins_with(sk, :check) AND #status = :completed AND attribute_exists(completedAt)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":site": "SITE#",
          ":check": "CHECK#",
          ":completed": "completed",
        },
        ProjectionExpression: "pk, sk, checkId, completedAt, flowType",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      if (
        item.flowType === "single-problem" ||
        typeof item.pk !== "string" ||
        typeof item.checkId !== "string" ||
        item.sk !== `CHECK#${item.checkId}` ||
        typeof item.completedAt !== "string"
      )
        continue;
      const siteId = item.pk.slice("SITE#".length);
      const record = checkCompletionRecord(
        siteId,
        item.checkId,
        item.completedAt,
      );
      eligible += 1;
      if (!apply) continue;
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tableName,
                  Key: checkHeaderKey(siteId, item.checkId),
                  ConditionExpression:
                    "#status = :completed AND completedAt = :at",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":completed": "completed",
                    ":at": item.completedAt,
                  },
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: record,
                  ConditionExpression: "attribute_not_exists(sk)",
                },
              },
            ],
          }),
        );
        written += 1;
      } catch (error) {
        const failure =
          /** @type {{name?: string, CancellationReasons?: Array<{Code?: string}>}} */ (
            error
          );
        if (
          failure.name === "TransactionCanceledException" &&
          failure.CancellationReasons?.some(
            (reason) => reason.Code === "ConditionalCheckFailed",
          ) &&
          failure.CancellationReasons.every((reason) =>
            ["None", "ConditionalCheckFailed"].includes(reason.Code || "None"),
          )
        ) {
          skipped += 1; // already migrated, or header deleted/changed concurrently
          continue;
        }
        throw error;
      }
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  if (apply) {
    await client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...COMPLETION_MIGRATION_KEY,
          status: "ready",
          completedAt: new Date().toISOString(),
        },
      }),
    );
  }
  return { eligible, written, skipped };
}
