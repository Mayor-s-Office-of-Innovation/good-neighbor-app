// @ts-check
/*
  Playwright globalTeardown: deletes the suite's table so every run starts
  from a pristine seed — the e2e analogue of "the table is disposable." With
  the table gone, the next run's backend boot re-creates it through the same
  ensureLocalInfra() path (schema mirrored from Terraform, site codes seeded),
  so checks and tasks are always coherent together.

  Each run owns a UUID-namespaced table and submission queue. Exact resource
  identity and loopback guards protect other runs and the developer's data.
  A hard kill may leave that run's disposable resources behind; later runs
  never reuse or delete them.
*/
import { assertRunResources } from "./helpers/run-resources.mjs";
import { DeleteQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(E2E_DIR, "..");
const DDB_ENDPOINT = "http://127.0.0.1:8000";

/** Same minimal .env.local reader as global-setup.mjs. */
function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch {
    // No .env.local — CI provides what's needed via the backend's own env.
  }
}

/** Same safeguards as global-setup's assertLocalOnly, table name included. */
function assertLocalOnly() {
  const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
  assertRunResources();
  if (!endpoint) {
    throw new Error(
      "[e2e-teardown] refusing to run: AWS_ENDPOINT_URL_DYNAMODB is not set.",
    );
  }
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(
      `[e2e-teardown] refusing to run: invalid AWS_ENDPOINT_URL_DYNAMODB "${endpoint}"`,
    );
  }
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(
      `[e2e-teardown] refusing to run: endpoint host "${host}" is not localhost/127.0.0.1.`,
    );
  }
}

export default async function globalTeardown() {
  loadEnvLocal();
  assertLocalOnly();
  const client = new DynamoDBClient({
    endpoint: DDB_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const { tableName, queueUrl } = assertRunResources();
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
    console.log(`[e2e-teardown] deleted table "${tableName}"`);
  } catch (err) {
    if (/** @type {Error} */ (err).name === "ResourceNotFoundException") {
      console.log(`[e2e-teardown] table "${tableName}" already absent`);
    } else {
      // A failed teardown leaves only this run's resources behind.
      // Warn without hiding the test result.
      console.warn(
        `[e2e-teardown] could not delete "${tableName}":`,
        /** @type {Error} */ (err).message,
      );
    }
  }
  const sqs = new SQSClient({
    endpoint: "http://localhost:9324",
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  try {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    console.log(`[e2e-teardown] deleted queue "${queueUrl}"`);
  } catch (err) {
    if (
      err.name !== "AWS.SimpleQueueService.NonExistentQueue" &&
      err.name !== "QueueDoesNotExist"
    )
      console.warn("[e2e-teardown] could not delete run queue:", err.message);
  } finally {
    sqs.destroy();
    client.destroy();
  }
}
