// Standalone bootstrap: create the local DynamoDB table + SQS queue, then exit.
// The API router and worker also call ensureLocalInfra() at startup, so this is
// mostly for explicit/first-run use (`npm run local:bootstrap`) or seeding.

import { ensureLocalInfra } from "./lib/ensure-infra.mjs";

ensureLocalInfra()
  .then(({ tableName, queueUrl }) => {
    console.log(`[bootstrap] ready — table "${tableName}", queue ${queueUrl}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[bootstrap] failed:", err);
    process.exit(1);
  });
