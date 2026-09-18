// @ts-check
/*
  Playwright globalSetup: runs after the webServers are healthy (backend /health
  gates on DDB Local being reachable), before any test.

  Why: DynamoDB Local persists between runs (-sharedDb in backend/.local), and
  two pieces of leftover state poison reruns:

  1. Seeded setup codes carry maxUses: 3. Every test registers a fresh device
     through the real flow, consuming a use — three reruns and the seed code
     401s ("Invalid site code"). The harness seed is deliberately write-once
     (attribute_not_exists), so re-seeding never resets counters.
     Fix: reset uses/maxUses on SETUP_CODE# items each run.

  2. TASK# items from previous runs stay `open` forever. The home worklist
     (GET /v1/tasks) returns them all, and isNewHomeTask files anything
     needs_action younger than 3h into the "New analysis results" tray — so
     reruns inherit a polluted NEW tray and card-counting can't scope to this
     run's guidance.
     Fix: delete TASK# items (and their GSI2 projection lives on the same
     item, so one delete suffices) each run.

  Both fixes are harmless in CI (fresh table) and self-healing locally. This
  is harness-only state repair; it never touches deployed environments
  (endpoint is hardcoded to the local emulator).
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
  const tableName = process.env.DYNAMO_TABLE || "gnp-local-app";

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
  await waitAndReset();
}
