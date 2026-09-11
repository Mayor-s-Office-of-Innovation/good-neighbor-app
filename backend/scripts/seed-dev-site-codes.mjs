import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { seedSiteCodes } from "./lib/site-code-seeds.mjs";

const tableName = process.env.DYNAMO_TABLE;

if (!tableName) {
  console.error("[seed] missing DYNAMO_TABLE");
  process.exit(1);
}

const docDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

seedSiteCodes(docDdb, tableName)
  .then(({ seededCodes }) => {
    console.log(`[seed] dev site codes ready: ${seededCodes.join(", ")}`);
  })
  .catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
