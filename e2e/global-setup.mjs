// @ts-check
/*
  Playwright globalSetup: runs after the webServers are healthy (backend /health
  gates on DDB Local being reachable), before any test.

  Why: the suite's own table (gnp-local-e2e, declared in playwright.config.js)
  may carry leftovers, and two pieces poison reruns:

  1. Seeded setup codes carry maxUses: 3. Every test registers a fresh device
     through the real flow, consuming a use — three reruns and the seed code
     401s ("Invalid site code"). The harness seed is deliberately write-once
     (attribute_not_exists), so re-seeding never resets counters.
     Fix: reset uses/maxUses on SETUP_CODE# items each run.

  2. TASK# items from previous runs stay `open` forever. The home worklist
     (GET /v1/tasks) returns them all, and recent tasks can appear in To do
     or the newest-check tray before this run creates its own check. Reruns
     would inherit unrelated cards and card-counting could not reliably
     scope to this run's guidance.
     Fix: delete TASK# items (their GSI2 projection lives on the same item,
     so one delete suffices) each run.

  Both are no-ops after globalTeardown wiped the table (the healthy state);
  they self-heal a run that died before teardown.

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
  2. DYNAMO_TABLE must equal the suite's dedicated table (gnp-local-e2e,
     the same value playwright.config.js pins for the spawned backend) — and
     when missing (CI with no config-provided value…), fall back to the suite
     table, never an inherited ambient value like the dev table.

  If either check fails, the setup aborts BEFORE any AWS call, failing the
  e2e job loudly instead of silently mutating shared data.
*/
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
/** The suite's own table — the ONLY table this script may touch. Must match
 * the value playwright.config.js pins for the spawned backend. */
const E2E_TABLE_NAME = "gnp-local-e2e";
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
  // No ambient fallback: an unset DYNAMO_TABLE always means the suite's own
  // table, never "inherit whatever the shell has" (the dev table leaking in
  // would otherwise be used).
  const tableName = process.env.DYNAMO_TABLE || E2E_TABLE_NAME;

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
  // Guard 2: table name must be the suite's OWN table, never the developer's
  // gnp-local-app (same DynamoDB Local instance hosts both) and never a
  // deployed namespace. Belt against guard 1's braces: a loopback endpoint
  // does not imply the right table.
  if (tableName !== E2E_TABLE_NAME) {
    throw new Error(
      `[e2e-global] refusing to run: DYNAMO_TABLE "${tableName}" is not the suite table "${E2E_TABLE_NAME}". ` +
        "The e2e suite must never mutate the dev table or any deployed table.",
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
  const tableName = process.env.DYNAMO_TABLE || E2E_TABLE_NAME;

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
}
