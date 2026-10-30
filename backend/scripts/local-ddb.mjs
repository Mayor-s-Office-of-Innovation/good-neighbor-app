// Launches DynamoDB Local (a Java jar the `dynamodb-local` package downloads on
// first run). Stays in the foreground so `concurrently` owns its lifecycle;
// stops the jar cleanly on SIGINT/SIGTERM so port 8000 isn't orphaned.
//
// Requires JRE 17+ (DynamoDB Local 2.x). `-sharedDb` is essential: without it,
// DynamoDB Local partitions data by (access key, region), so the bootstrap step
// and the handlers could end up looking at different databases.
//
// The `dynamodb-local` package defaults its install to os.tmpdir(), which macOS
// periodically reaps (files under /var/folders untouched for a few days get
// deleted). That leaves a partial jar bundle — missing slf4j-api / servlet-api —
// which crashes on startup with NoClassDefFoundError. Install into backend/.local/
// instead (the same persistent, git-ignored dir minio/elasticmq use) so it isn't
// reaped between runs.

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import DynamoDbLocal from "dynamodb-local";

const PORT = Number(process.env.LOCAL_DDB_PORT ?? 8000);
// The e2e suite runs its own throwaway copy (LOCAL_DDB_IN_MEMORY=true) beside
// the dev one, so nothing it writes outlives the run.
const IN_MEMORY = process.env.LOCAL_DDB_IN_MEMORY === "true";

const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
DynamoDbLocal.configureInstaller({
  installPath: join(backendDir, ".local", "dynamodb-local"),
});

async function main() {
  // A null dbPath makes the launcher use -inMemory. The dev copy keeps its data
  // alongside the other local stores so records survive a restart.
  const dataPath = IN_MEMORY
    ? null
    : join(backendDir, ".local", "dynamodb-data");
  if (dataPath) await mkdir(dataPath, { recursive: true });
  console.log(
    `[ddb] starting DynamoDB Local on :${PORT}${IN_MEMORY ? " (in memory)" : ""} (JRE 17+ required)…`,
  );
  await DynamoDbLocal.launch(PORT, dataPath, ["-sharedDb"]);
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
