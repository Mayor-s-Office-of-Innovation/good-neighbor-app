import { ddb } from "../src/db.js";
import { backfillCheckCompletions } from "../src/domain/backfill-check-completions.js";

const tableName = process.env.DYNAMO_TABLE;
if (!tableName) {
  console.error("DYNAMO_TABLE is required");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  console.error(
    "Usage: backfill-check-completions.mjs [--apply] (default: dry run)",
  );
  process.exit(1);
}
try {
  const result = await backfillCheckCompletions(ddb, tableName, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...result }));
} catch (error) {
  console.error(
    "Completion backfill failed; readiness was not updated.",
    error,
  );
  process.exitCode = 1;
}
