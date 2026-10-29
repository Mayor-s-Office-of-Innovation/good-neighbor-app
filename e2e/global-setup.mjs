// @ts-check
/*
  Playwright globalSetup: runs after the webServers are healthy (backend /health
  gates on DDB Local being reachable), before any test.

  Why: seeded setup codes carry maxUses: 3, and every test registers a fresh
  device through the real flow, consuming a use — the fourth test's code entry
  would 401 ("Invalid site code"). The harness seed is deliberately write-once
  (attribute_not_exists), so re-seeding never resets counters.
  Fix: reset uses/maxUses on SETUP_CODE# items.

  The suite's DynamoDB Local runs in memory on its own port (helpers/ports.js),
  so each run starts from an empty, freshly seeded table and nothing outlives
  it — no leftover cleanup or teardown is needed.

  ── Safeguard ────────────────────────────────────────────────────────────
  This script MUTATES setup codes, and the suite binds devices + seeds test
  data. It must never touch a deployed table, and it must never touch the
  developer's own `npm run dev` database. Two independent guards, both
  required:

  1. AWS_ENDPOINT_URL_DYNAMODB must be SET to the suite's own DynamoDB Local
     (loopback, E2E_PORTS.ddb) — the SDK-only mechanism that redirects at the
     local emulator (.env.example). Deployed environments never set it
     (Terraform), and the dev copy listens on another port. The harness's
     own client uses DDB_ENDPOINT below, so this check guards THAT target.
  2. DYNAMO_TABLE must equal the suite's dedicated table (gnp-local-e2e,
     the same value playwright.config.js pins for the spawned backend) — and
     when missing (CI with no config-provided value…), fall back to the suite
     table, never an inherited ambient value like the dev table.

  If either check fails, the setup aborts BEFORE any AWS call, failing the
  e2e job loudly instead of silently mutating shared data.
*/
import { backfillCheckCompletions } from "../backend/src/domain/backfill-check-completions.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_PORTS, E2E_URLS } from "./helpers/ports.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(E2E_DIR, "..");
const DDB_ENDPOINT = E2E_URLS.ddb;
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
  if (Number(new URL(endpoint).port) !== E2E_PORTS.ddb) {
    throw new Error(
      `[e2e-global] refusing to run: AWS_ENDPOINT_URL_DYNAMODB "${endpoint}" is not the suite's own DynamoDB Local (port ${E2E_PORTS.ddb}). ` +
        "The e2e suite must never mutate the dev database.",
    );
  }
  // Guard 2: table name must be the suite's OWN table, never the developer's
  // gnp-local-app and never a deployed namespace. Belt against guard 1's
  // braces: the right endpoint does not imply the right table.
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
 * @returns {Promise<Array<{ pk: string, sk: string }>>}
 */
async function scanAllByPrefix(doc, tableName, prefix) {
  /** @type {Array<{ pk: string, sk: string }>} */
  const items = [];
  let exclusiveStartKey;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(pk, :prefix)",
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
      // Setup codes: reset usage counters.
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
}
