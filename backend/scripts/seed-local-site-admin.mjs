// Only local emulators are allowed; --reset explicitly deletes the local app table.
import {
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import {
  assertLocalSeedTarget,
  seedLocalSiteAdmin,
} from "./lib/site-admin-seed.mjs";
import { ensureLocalInfra } from "./lib/ensure-infra.mjs";
assertLocalSeedTarget();
process.env.LOCAL_SITE_ADMIN_SEED = "true";
if (process.argv.includes("--reset")) {
  const client = new DynamoDBClient({});
  const TableName = process.env.DYNAMO_TABLE;
  try {
    await client.send(new DeleteTableCommand({ TableName }));
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
  }
  await waitUntilTableNotExists({ client, maxWaitTime: 30 }, { TableName });
  console.log(`[seed] reset local table ${TableName}`);
}
await ensureLocalInfra();
await seedLocalSiteAdmin();
