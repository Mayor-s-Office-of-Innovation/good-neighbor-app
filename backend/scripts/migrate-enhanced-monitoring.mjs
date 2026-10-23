// Explicit remote targeting is opt-in; all targets default to a dry run.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  migrationTarget,
  monitoringUpdates,
} from "./lib/enhanced-monitoring-migration.mjs";

const target = migrationTarget(process.argv.slice(2), process.env);
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient(
    target.remote
      ? { region: target.region, ignoreConfiguredEndpointUrls: true }
      : {},
  ),
);
let cursor;
const report = { ...target, candidates: 0, converted: 0, conflicts: 0 };
do {
  const page = await client.send(
    new ScanCommand({
      TableName: target.table,
      ConsistentRead: true,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }),
  );
  for (const item of page.Items || []) {
    for (const update of monitoringUpdates(item, target.table)) {
      report.candidates++;
      if (!target.apply) continue;
      try {
        await client.send(new UpdateCommand(update));
        report.converted++;
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
        report.conflicts++;
      }
    }
  }
  cursor = page.LastEvaluatedKey;
} while (cursor);
console.log(JSON.stringify(report, null, 2));
if (report.conflicts) process.exitCode = 1;
