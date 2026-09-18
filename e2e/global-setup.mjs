// @ts-check
/*
  Playwright globalSetup: runs after the webServers are healthy (backend /health
  gates on DDB Local being reachable), before any test.

  Why: DynamoDB Local persists between runs (-sharedDb in backend/.local), and
  three pieces of leftover state poison reruns:

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
     Fix: delete TASK# items (their GSI2 projection lives on the same item,
     so one delete suffices) each run.

  3. The seeded sites' place lists mutate through real app usage: any "Save
     places" (a manual dev session, or this suite's own places-gate pass)
     replaces the `places` array and stamps `placesConfiguredAt` on the SITE#
     item (handlers/site.js putSitePlaces), and the harness seed is
     write-once (if_not_exists) — so manual edits persist across every later
     run and the suite fails in bindSite: the gate never appears and the
     seeded place names are gone.
     Fix: rewrite each seeded site's places to the seed list and strip
     placesConfiguredAt, restoring the first-run gate the suite expects.

  All fixes are harmless in CI (fresh table) and self-healing locally.

  ── Production safeguard ────────────────────────────────────────────────
  This script MUTATES site metadata and DELETES tasks, and the suite binds
  devices + seeds test data. It must never touch a deployed table. Two
  independent guards, both required:

  1. AWS_ENDPOINT_URL_DYNAMODB must be SET and resolve to localhost /
     127.0.0.1 — the SDK-only mechanism that redirects at the local
     emulator (.env.example). Deployed environments never set it
     (Terraform). The value the harness's own client uses is hardcoded in
     DDB_ENDPOINT below, so this check guards THAT client's target.
  2. DYNAMO_TABLE must equal the harness's local table name — and when
     missing (CI with no .env.local), fall back to LOCAL_TABLE_NAME, never
     an inherited ambient value.

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
/** The harness's own table name — the ONLY table this script may touch. */
const LOCAL_TABLE_NAME = "gnp-local-app";
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
  // No ambient fallback: an unset DYNAMO_TABLE always means the harness's own
  // table, never "inherit whatever the shell has" (a deployed env var leaking
  // in would otherwise be used).
  const tableName = process.env.DYNAMO_TABLE || LOCAL_TABLE_NAME;

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
  // Guard 2: table name must be the harness's own (belt to guard 1's braces —
  // protects against a non-local endpoint that proxy-resolves localhost, e.g.
  // a corporate DNS wildcard, from being trusted on the name check alone).
  if (tableName !== LOCAL_TABLE_NAME) {
    throw new Error(
      `[e2e-global] refusing to run: DYNAMO_TABLE "${tableName}" is not the local harness table "${LOCAL_TABLE_NAME}".`,
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
  const tableName = process.env.DYNAMO_TABLE || LOCAL_TABLE_NAME;

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

      // 3. Sites: restore each seeded site's place list + first-run gate.
      // A manual dev session (or a previous run's own places-gate pass)
      // replaces `places` and stamps `placesConfiguredAt` via
      // PUT /v1/site/places; the harness seed is write-once and never
      // repairs it. The seed module is the single source of truth for the
      // place lists — imported directly from the backend seeds.
      const sitesRewritten = await restoreSeededSites(doc, tableName);
      console.log(`[e2e-global] restored ${sitesRewritten} seeded site(s)`);
      return;
    } catch (err) {
      if (attempt === RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

/**
 * Rewrite each seeded site's `places` to the seed list and strip the
 * `placesConfiguredAt` stamp, restoring the first-run places gate. Only the
 * sites in devSiteCodeSeeds (imported from the backend seed module — single
 * source of truth) are touched.
 * @param {DynamoDBDocumentClient} doc
 * @param {string} tableName
 * @returns {Promise<number>} number of sites rewritten
 */
async function restoreSeededSites(doc, tableName) {
  const seedsPath = resolve(
    ROOT,
    "backend",
    "scripts",
    "lib",
    "site-code-seeds.mjs",
  );
  const { devSiteCodeSeeds } = await import(`file://${seedsPath}`);
  for (const seed of devSiteCodeSeeds) {
    await doc.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: `SITE#${seed.siteId}`, sk: "#META" },
        UpdateExpression:
          "SET places = :places, siteId = :siteId, #name = :name REMOVE placesConfiguredAt",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: {
          ":places": seed.places,
          ":siteId": seed.siteId,
          ":name": seed.siteName,
        },
      }),
    );
  }
  return devSiteCodeSeeds.length;
}

export default async function globalSetup() {
  loadEnvLocal();
  assertLocalOnly();
  await waitAndReset();
}
