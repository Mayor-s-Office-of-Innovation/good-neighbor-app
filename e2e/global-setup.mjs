// @ts-check
/*
  Playwright globalSetup: runs after the webServers are healthy (backend /health
  gates on DDB Local being reachable), before any test.

  Every invocation owns a new UUID-namespaced table. Reset the seeded setup
  code counters/limits so the suite can enroll more than three devices, and
  clear any task records if setup is repeated within the same invocation.
  A hard-killed run's abandoned table is never reused by a later invocation.

  ── Safeguard ────────────────────────────────────────────────────────────
  This script MUTATES setup codes and DELETES tasks, and the suite binds
  devices + seeds test data. It must never touch a deployed table, and it
  must never touch the developer's own `npm run dev` table (which shares the
  same DynamoDB Local instance). Two independent guards, both required:

  1. AWS_ENDPOINT_URL_DYNAMODB must be SET and resolve to localhost /
     127.0.0.1 — the SDK-only mechanism that redirects at the local
     emulator (.env.example). Deployed environments never set it
     (Terraform). The value the harness's own client uses is hardcoded in
     DDB_ENDPOINT below, so this check guards THAT client's target.
  2. DYNAMO_TABLE must equal the suite's dedicated table (gnp-local-e2e-<runId>,
     the same value playwright.config.js pins for the spawned backend), and
     the submission queue must match the same run identity. Missing ownership
     information fails closed rather than falling back to an ambient resource.

  If either check fails, the setup aborts BEFORE any AWS call, failing the
  e2e job loudly instead of silently mutating shared data.
*/
import { backfillCheckCompletions } from "../backend/src/domain/backfill-check-completions.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watchBackend } from "./helpers/backend-watch.mjs";
import { assertRunResources } from "./helpers/run-resources.mjs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(E2E_DIR, "..");
const DDB_ENDPOINT = "http://127.0.0.1:8000";
const RETRIES = 30;
const RETRY_DELAY_MS = 1000;

/** Minimal .env.local reader (KEY=VALUE lines; the backend loads it the same way). */
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

/**
 * Refuse to run against anything resembling a deployed table, BEFORE any AWS
 * call. The backend webServer sets AWS_ENDPOINT_URL_DYNAMODB +
 * DYNAMO_TABLE (playwright.config env overrides), so in every supported
 * context — local with .env.local, and CI — both vars are present and
 * loopback/local-table-valued. If a future change boots the harness some
 * other way (or someone wires the suite at a deployed table), the guards
 * below abort before a single AWS call is made.
 * @returns {void}
 * @throws {Error} when any guard fails
 */
function assertLocalOnly() {
  const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
  // Require the exact run-owned table and queue; never inherit dev resources.
  assertRunResources();

  // Guard 1: the .env.local-loaded (or CI-provided) endpoint must exist and
  // point at the loopback emulator. This is the same var the harness's own
  // clients use, so checking it here also documents/asserts what the backend
  // will be pointed at for the run.
  if (!endpoint) {
    throw new Error(
      "[e2e-global] refusing to run: AWS_ENDPOINT_URL_DYNAMODB is not set. " +
        "This script mutates/deletes data and must never target a deployed table.",
    );
  }
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(
      `[e2e-global] refusing to run: invalid AWS_ENDPOINT_URL_DYNAMODB "${endpoint}"`,
    );
  }
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(
      `[e2e-global] refusing to run: AWS_ENDPOINT_URL_DYNAMODB host "${host}" is not localhost/127.0.0.1. ` +
        "This script mutates/deletes data and must never target a deployed table.",
    );
  }
}

/**
 * Scan with a FilterExpression across ALL pages (Scan reads ≤1 MB before
 * filtering, so one call can miss matching items past the first page).
 * @param {DynamoDBDocumentClient} doc
 * @param {string} tableName
 * @param {string} prefix
 * @param {"pk" | "sk"} [keyAttribute] Which key to prefix-match on. Tasks key
 *   on sk (TASK#<taskId>), everything else on pk.
 * @returns {Promise<Array<{ pk: string, sk: string }>>}
 */
async function scanAllByKeyPrefix(doc, tableName, prefix, keyAttribute = "pk") {
  /** @type {Array<{ pk: string, sk: string }>} */
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(#k, :prefix)",
        ExpressionAttributeNames: { "#k": keyAttribute },
        ExpressionAttributeValues: { ":prefix": prefix },
        ProjectionExpression: "pk, sk",
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return /** @type {Array<{ pk: string, sk: string }>} */ (items);
}

const scanAllByPrefix = (doc, tableName, prefix) =>
  scanAllByKeyPrefix(doc, tableName, prefix, "pk");

const scanAllBySkPrefix = (doc, tableName, prefix) =>
  scanAllByKeyPrefix(doc, tableName, prefix, "sk");

async function waitAndReset() {
  const client = new DynamoDBClient({
    endpoint: DDB_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const doc = DynamoDBDocumentClient.from(client);
  const { tableName } = assertRunResources();

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      // 1. Setup codes: reset usage counters.
      const codes = await scanAllByPrefix(doc, tableName, "SETUP_CODE#");
      for (const item of codes) {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: "SET uses = :zero, maxUses = :many",
            ExpressionAttributeValues: { ":zero": 0, ":many": 1000 },
          }),
        );
      }
      console.log(
        `[e2e-global] reset ${codes.length} setup code(s) in "${tableName}"`,
      );

      // 2. Tasks: drop leftovers so the home worklist starts clean. Tasks key
      // on sk = TASK#<taskId> (handlers/keys.js taskKey), so filter on sk.
      const tasks = await scanAllBySkPrefix(doc, tableName, "TASK#");
      for (const item of tasks) {
        await doc.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { pk: item.pk, sk: item.sk },
          }),
        );
      }
      console.log(`[e2e-global] cleared ${tasks.length} leftover task(s)`);
      // Exercise the same migration/readiness gate required before deployment.
      await backfillCheckCompletions(doc, tableName, true);
      return;
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

export default async function globalSetup() {
  loadEnvLocal();
  assertLocalOnly();
  await waitAndReset();
  return watchBackend(
    `http://127.0.0.1:${process.env.E2E_API_PORT ?? 3001}/health`,
  );
}
