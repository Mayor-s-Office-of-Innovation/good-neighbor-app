import { createHash } from "node:crypto";
import { ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { personRecord, personPut } from "../src/lib/people.js";
import { getDynamoTableName } from "../src/config.js";
const apply = process.argv.includes("--apply");
const merge = false; // Existing people remain separate; no email-based identity merging.
const rows = [];
let cursor;
do {
  const result = await ddb.send(
    new ScanCommand({
      TableName: getDynamoTableName(),
      ExclusiveStartKey: cursor,
      ConsistentRead: true,
    }),
  );
  rows.push(...(result.Items || []));
  cursor = result.LastEvaluatedKey;
} while (cursor);
const contacts = rows.filter(
  (r) =>
    ((r.sk.startsWith("USER#") && r.pk.startsWith("PROGRAM#")) ||
      r.sk.startsWith("PROVIDER_MANAGER#")) &&
    !r.personId,
);
const groups = new Map();
for (const row of contacts) {
  const identity = `${row.pk}|${row.sk}`;
  const group = groups.get(identity) || [];
  group.push(row);
  groups.set(identity, group);
}
let migrated = 0;
const conflicts = [];
for (const group of groups.values()) {
  const first = group[0];
  const personId = createHash("sha256")
    .update(`${first.pk}|${first.sk}`)
    .digest("hex")
    .slice(0, 24);
  const linked = rows.filter(
    (r) =>
      !r.personId &&
      r.pk.startsWith("SITE#") &&
      (r.sk.startsWith("MANAGER_MEMBERSHIP#") ||
        r.sk.startsWith("ASSIGNED_USER#")) &&
      group.some(
        (c) => c.userId && c.userId === r.userId && c.programId === r.programId,
      ),
  );
  const sources = [...group, ...linked].map((r) => ({ pk: r.pk, sk: r.sk }));
  if (sources.length + 1 > 100) {
    conflicts.push({ personId, reason: "transaction_limit" });
    continue;
  }
  const person = personRecord(
    {
      ...first,
      primaryProgramId: first.programId || "",
      primaryProviderId:
        first.providerId ||
        rows.find(
          (r) => r.pk === `PROGRAM#${first.programId}` && r.sk === "#META",
        )?.providerId ||
        "",
      siteManager: group.some((r) => r.siteManager) || linked.length > 0,
    },
    personId,
    sources,
  );
  if (apply)
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          personPut(person),
          ...[...group, ...linked].map((row) => ({
            Update: {
              TableName: getDynamoTableName(),
              Key: { pk: row.pk, sk: row.sk },
              UpdateExpression: "SET personId = :person",
              ConditionExpression: `attribute_exists(pk) AND attribute_not_exists(personId) AND ${row.updatedAt ? "updatedAt = :updated" : "attribute_not_exists(updatedAt)"}`,
              ExpressionAttributeValues: {
                ":person": personId,
                ...(row.updatedAt ? { ":updated": row.updatedAt } : {}),
              },
            },
          })),
        ],
      }),
    );
  migrated++;
}
console.log(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      mergeMatching: merge,
      people: migrated,
      conflicts,
    },
    null,
    2,
  ),
);
