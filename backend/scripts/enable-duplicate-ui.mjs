import { ddb } from "../src/db.js";
import { enableDuplicateUi } from "../src/domain/enable-duplicate-ui.js";

const tableName = process.env.DYNAMO_TABLE;
if (!tableName || process.argv.slice(2).some((arg) => arg !== "--apply")) {
  console.error(
    "Usage: DYNAMO_TABLE=<table> node backend/scripts/enable-duplicate-ui.mjs [--apply]",
  );
  process.exit(1);
}
const apply = process.argv.includes("--apply");
try {
  console.log(
    JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      ...(await enableDuplicateUi(ddb, tableName, apply)),
    }),
  );
} catch (error) {
  // Do not print Site records or AWS request contents.
  console.error(
    "Duplicate UI rollout failed; rerun after resolving the failure.",
    error?.name,
  );
  process.exitCode = 1;
}
