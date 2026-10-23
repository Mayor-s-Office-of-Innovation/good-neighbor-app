/*
  Backfill the GSI1 timeline keys the site manager reports read:

    TASK#        items → gsi1pk SITE#<siteId>#TASK,   gsi1sk <createdAt>#<taskId>
    task_update  events → gsi1pk SITE#<siteId>#UPDATE, gsi1sk <occurredAt>#<updateId>

  New items are stamped at write time (keys.js taskTimelineGsi /
  taskUpdateTimelineGsi); this fills in items written before that. Dry run
  by default: prints what it would change. Pass --apply to write. Idempotent:
  only items without gsi1pk are touched, and the update is conditional on
  that still being true.

    DYNAMO_TABLE=gnp-dev-app npm run backfill:report-timelines -w backend
    DYNAMO_TABLE=gnp-dev-app npm run backfill:report-timelines -w backend -- --apply

  Never run this against production from a laptop; production data
  operations are run by the developer through the approved path.
*/
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  taskTimelineGsi,
  taskUpdateTimelineGsi,
} from "../src/handlers/keys.js";

const tableName = process.env.DYNAMO_TABLE;
const apply = process.argv.includes("--apply");

if (!tableName) {
  console.error("[backfill] missing DYNAMO_TABLE");
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

backfillReportTimelines(ddb, tableName, apply)
  .then(({ scanned, stamped, skipped }) => {
    console.log(
      `[backfill] ${apply ? "applied" : "dry run"}: scanned ${scanned} items, ` +
        `${apply ? "stamped" : "would stamp"} ${stamped}, skipped ${skipped}`,
    );
  })
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });

/**
 * The GSI1 keys an item should carry, or null when it cannot be stamped.
 * @param {Record<string, any>} item
 * @returns {{ gsi1pk: string, gsi1sk: string } | null}
 */
export function timelineKeysFor(item) {
  const siteId = String(item.pk ?? "").startsWith("SITE#")
    ? String(item.pk).slice("SITE#".length)
    : "";
  if (!siteId) return null;
  if (item.entityType === "TASK") {
    if (!item.createdAt || !item.taskId) return null;
    return taskTimelineGsi(siteId, String(item.createdAt), String(item.taskId));
  }
  if (item.entityType === "task_update") {
    if (!item.occurredAt || !item.updateId) return null;
    return taskUpdateTimelineGsi(
      siteId,
      String(item.occurredAt),
      String(item.updateId),
    );
  }
  return null;
}

/**
 * @param {DynamoDBDocumentClient} client
 * @param {string} table
 * @param {boolean} write
 * @returns {Promise<{ scanned: number, stamped: number, skipped: number }>}
 */
async function backfillReportTimelines(client, table, write) {
  let scanned = 0;
  let stamped = 0;
  let skipped = 0;
  /** @type {Record<string, any> | undefined} */
  let ExclusiveStartKey;

  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey,
        FilterExpression:
          "(entityType = :task OR entityType = :update) AND attribute_not_exists(gsi1pk)",
        ExpressionAttributeValues: {
          ":task": "TASK",
          ":update": "task_update",
        },
      }),
    );

    for (const item of page.Items ?? []) {
      scanned += 1;
      const keys = timelineKeysFor(item);
      if (!keys) {
        skipped += 1;
        console.warn(
          `[backfill] skipped ${item.pk} / ${item.sk}: no timestamp`,
        );
        continue;
      }
      if (write) {
        await client.send(
          new UpdateCommand({
            TableName: table,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: "SET gsi1pk = :pk, gsi1sk = :sk",
            ConditionExpression: "attribute_not_exists(gsi1pk)",
            ExpressionAttributeValues: {
              ":pk": keys.gsi1pk,
              ":sk": keys.gsi1sk,
            },
          }),
        );
      } else {
        console.log(
          `[backfill] would stamp ${item.sk} → ${keys.gsi1pk} / ${keys.gsi1sk}`,
        );
      }
      stamped += 1;
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return { scanned, stamped, skipped };
}
