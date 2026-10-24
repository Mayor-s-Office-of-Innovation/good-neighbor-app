// One-time directory/read-model initialization. Run through approved deployment
// operations after stream deployment; never invent legacy receipt timestamps.
import { ScanCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { getDynamoTableName } from "../src/config.js";
import { projectStatus, statusRecords } from "../src/domain/system-status.js";
const apply = process.argv.includes("--apply");
const table = getDynamoTableName();
const trackingSince = new Date().toISOString();
let cursor,
  count = 0;
do {
  const page = await ddb.send(
    new ScanCommand({
      TableName: table,
      ConsistentRead: true,
      ExclusiveStartKey: cursor,
    }),
  );
  for (const item of page.Items || []) {
    count += statusRecords(item).length;
    if (apply) await projectStatus(item);
  }
  cursor = page.LastEvaluatedKey;
} while (cursor);
if (apply) {
  const key = { pk: "SYSTEM#STATUS", sk: "#META" };
  const prior = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...key,
        ready: true,
        trackingSince: prior.Item?.trackingSince || trackingSince,
      },
    }),
  );
}
console.log(JSON.stringify({ apply, records: count }));
