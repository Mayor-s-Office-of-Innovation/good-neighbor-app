// Backfill and repair the program-staff assignment pointers
// (backend/src/lib/assignment-pointers.js). Every `SITE#<site>/ASSIGNED_USER#<user>`
// row should have a `PROGRAM#<program>/USER_SITE#<user>#<site>` pointer, and no
// pointer should outlive its assignment. Runs in the deploy workflow:
//   node backend/scripts/migrate-assignment-pointers.mjs          # report only
//   node backend/scripts/migrate-assignment-pointers.mjs --apply  # write fixes
// Safe to repeat. Prints counts only: no ids, names or contact details.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { getDynamoTableName } from "../src/config.js";
import { assignmentPointerKey } from "../src/lib/assignment-pointers.js";

const BATCH = 25;

/** @param {{ pk: string, sk: string }} key */
const id = (key) => `${key.pk}|${key.sk}`;

/**
 * @param {{ apply?: boolean, client?: { send: (command: any) => Promise<any> }, now?: string }} [options]
 */
export async function migrateAssignmentPointers({
  apply = false,
  client = ddb,
  now = new Date().toISOString(),
} = {}) {
  const tableName = getDynamoTableName();
  /** @type {Array<Record<string, any>>} */
  const assignments = [];
  /** @type {Array<Record<string, any>>} */
  const pointers = [];
  let cursor;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
        ProjectionExpression: "pk, sk, programId, userId, siteId",
      }),
    );
    for (const row of page.Items || []) {
      const pk = String(row.pk || "");
      const sk = String(row.sk || "");
      if (pk.startsWith("SITE#") && sk.startsWith("ASSIGNED_USER#"))
        assignments.push(row);
      else if (pk.startsWith("PROGRAM#") && sk.startsWith("USER_SITE#"))
        pointers.push(row);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  /** @type {Map<string, Record<string, any>>} */
  const expected = new Map();
  let unlinkable = 0;
  for (const row of assignments) {
    const programId = String(row.programId || "");
    const userId = String(row.userId || row.sk.slice("ASSIGNED_USER#".length));
    const siteId = String(row.siteId || row.pk.slice("SITE#".length));
    if (!programId || !userId || !siteId) {
      unlinkable += 1;
      continue;
    }
    const key = assignmentPointerKey(programId, userId, siteId);
    expected.set(id(key), {
      ...key,
      type: "programUserSitePointer",
      programId,
      userId,
      siteId,
      createdAt: now,
    });
  }
  const existing = new Set(pointers.map((row) => id(row)));
  const missing = [...expected.values()].filter(
    (item) => !existing.has(id(item)),
  );
  const orphaned = pointers.filter((row) => !expected.has(id(row)));

  if (apply) {
    // Transactions, not BatchWrite: the deploy role is granted scan and
    // transaction access on the app table (docs/runbooks/people-migration.md).
    const items = [
      ...missing.map((Item) => ({ Put: { TableName: tableName, Item } })),
      ...orphaned.map((row) => ({
        Delete: { TableName: tableName, Key: { pk: row.pk, sk: row.sk } },
      })),
    ];
    for (let i = 0; i < items.length; i += BATCH) {
      await client.send(
        new TransactWriteCommand({ TransactItems: items.slice(i, i + BATCH) }),
      );
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    assignments: assignments.length,
    pointers: pointers.length,
    missing: missing.length,
    orphaned: orphaned.length,
    unlinkable,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await migrateAssignmentPointers({
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(report, null, 2));
}
