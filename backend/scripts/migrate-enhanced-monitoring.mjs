// One-time conversion of legacy test data. Defaults to a dry run.
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { assertLocalSeedTarget } from "./lib/site-admin-seed.mjs";

assertLocalSeedTarget();
const apply = process.argv.includes("--apply");
const TableName = process.env.DYNAMO_TABLE;
let cursor;
let converted = 0;
do {
  const page = await ddb.send(
    new ScanCommand({
      TableName,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      ConsistentRead: true,
    }),
  );
  for (const item of page.Items || []) {
    if (!String(item.pk).startsWith("SITE#")) continue;
    const Key = { pk: item.pk, sk: item.sk };
    if (item.sk === "#META" && item.compliance?.currentTier !== undefined) {
      const { currentTier, ...compliance } = item.compliance;
      compliance.underEnhancedMonitoring =
        compliance.perimeterChecksRequired !== false && Boolean(currentTier);
      if (apply)
        await ddb.send(
          new UpdateCommand({
            TableName,
            Key,
            UpdateExpression: "SET compliance = :new",
            ConditionExpression: "compliance = :old",
            ExpressionAttributeValues: {
              ":new": compliance,
              ":old": item.compliance,
            },
          }),
        );
      converted++;
    }
    if (
      String(item.sk).startsWith("COMPLIANCE_TERMS#") &&
      item.correctiveActionTier !== undefined
    ) {
      if (apply)
        await ddb.send(
          new UpdateCommand({
            TableName,
            Key,
            UpdateExpression:
              "SET underEnhancedMonitoring = :flag REMOVE correctiveActionTier",
            ConditionExpression: "correctiveActionTier = :old",
            ExpressionAttributeValues: {
              ":flag": Boolean(item.correctiveActionTier),
              ":old": item.correctiveActionTier,
            },
          }),
        );
      converted++;
    }
  }
  cursor = page.LastEvaluatedKey;
} while (cursor);
console.log(JSON.stringify({ apply, converted }));
