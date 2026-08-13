// Launches DynamoDB Local (a Java jar the `dynamodb-local` package downloads on
// first run). Stays in the foreground so `concurrently` owns its lifecycle;
// stops the jar cleanly on SIGINT/SIGTERM so port 8000 isn't orphaned.
//
// Requires JRE 17+ (DynamoDB Local 2.x). `-sharedDb` is essential: without it,
// DynamoDB Local partitions data by (access key, region), so the bootstrap step
// and the handlers could end up looking at different databases.

import DynamoDbLocal from "dynamodb-local";

const PORT = 8000;

async function main() {
  console.log(`[ddb] starting DynamoDB Local on :${PORT} (JRE 17+ required)…`);
  await DynamoDbLocal.launch(PORT, null, ["-sharedDb"]);
  console.log(`[ddb] DynamoDB Local ready on http://localhost:${PORT}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[ddb] ${signal} received, stopping DynamoDB Local…`);
    try {
      await DynamoDbLocal.stop(PORT);
    } catch {
      // best-effort: process is exiting anyway
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive; the jar runs as a child of this process.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("[ddb] failed to start:", err);
  process.exit(1);
});
