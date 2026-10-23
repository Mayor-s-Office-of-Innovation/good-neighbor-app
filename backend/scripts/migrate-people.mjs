import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../src/db.js";
import { personRecord, personPut } from "../src/lib/people.js";
import { getDynamoTableName } from "../src/config.js";

const key = (row) => `${row.pk}|${row.sk}`;
const reference = ({ pk, sk }) => ({ pk, sk });
const isContact = (row) =>
  (row.pk.startsWith("PROGRAM#") && row.sk.startsWith("USER#")) ||
  (row.pk.startsWith("PROVIDER#") && row.sk.startsWith("PROVIDER_MANAGER#"));

// Only explicit source references establish identity; matching names/emails never do.
export async function migratePeople({ apply = false, client = ddb } = {}) {
  const rows = [];
  let cursor;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: getDynamoTableName(),
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
      }),
    );
    rows.push(...(result.Items || []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const contacts = rows.filter(isContact);
  const byKey = new Map(contacts.map((row) => [key(row), row]));
  const parent = new Map(contacts.map((row) => [key(row), key(row)]));
  const root = (id) => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current);
    return current;
  };
  const union = (a, b) => parent.set(root(a), root(b));
  const sourceKeys = new Map();
  const problems = new Map();
  const knownPeople = new Map();
  for (const row of contacts) {
    const id = key(row);
    if (row.personId) {
      if (knownPeople.has(row.personId))
        union(id, knownPeople.get(row.personId));
      else knownPeople.set(row.personId, id);
    }
    if (!row.staffSource) continue;
    const source = row.staffSource;
    const sourceKey = source.providerManagerId
      ? `PROVIDER#${source.providerId}|PROVIDER_MANAGER#${source.providerManagerId}`
      : `PROGRAM#${source.programId}|USER#${source.userId}`;
    sourceKeys.set(id, sourceKey);
    if (!byKey.has(sourceKey)) problems.set(id, "source_not_found");
    else union(id, sourceKey);
  }
  for (const row of contacts) {
    const seen = new Set();
    let current = key(row);
    while (sourceKeys.has(current) && byKey.has(current)) {
      if (seen.has(current)) {
        problems.set(key(row), "source_cycle");
        break;
      }
      seen.add(current);
      current = sourceKeys.get(current);
    }
  }
  const groups = new Map();
  for (const row of contacts) {
    const id = root(key(row));
    const group = groups.get(id) || [];
    group.push(row);
    groups.set(id, group);
  }
  const conflicts = [];
  let migrated = 0;
  for (const group of groups.values()) {
    const groupKeys = new Set(group.map(key));
    const linked = rows.filter(
      (row) =>
        row.pk.startsWith("SITE#") &&
        (row.sk.startsWith("MANAGER_MEMBERSHIP#") ||
          row.sk.startsWith("ASSIGNED_USER#")) &&
        row.userId &&
        groupKeys.has(`PROGRAM#${row.programId}|USER#${row.userId}`),
    );
    const records = [...group, ...linked];
    const ids = new Set(records.map((row) => row.personId).filter(Boolean));
    const existing =
      ids.size === 1
        ? rows.find(
            (row) => row.pk === "PEOPLE" && row.sk === `PERSON#${[...ids][0]}`,
          )
        : null;
    const sources = [
      ...new Map(
        [...(existing?.sources || []), ...records.map(reference)].map(
          (source) => [key(source), reference(source)],
        ),
      ).values(),
    ];
    // Already fully linked groups require no write, but incomplete historical links do.
    if (
      existing &&
      records.every((row) => row.personId === existing.personId) &&
      sources.length === (existing.sources || []).length
    )
      continue;
    const first = group.find((row) => !sourceKeys.has(key(row))) || group[0];
    const personId =
      [...ids][0] ||
      createHash("sha256").update(key(first)).digest("hex").slice(0, 24);
    let reason = group.map((row) => problems.get(key(row))).find(Boolean);
    if (ids.size > 1) reason = "person_identity_conflict";
    else if (ids.size && (!existing || !existing.revision))
      reason = "person_not_found_or_unversioned";
    if (
      !reason &&
      sources.some((source) => {
        const row = rows.find((item) => key(item) === key(source));
        return row?.personId && row.personId !== personId;
      })
    )
      reason = "person_source_conflict";
    if (records.length + 1 > 100) reason = "transaction_limit";
    if (reason) {
      conflicts.push({ personId, sources: records.map(reference), reason });
      continue;
    }
    const person = existing
      ? {
          ...existing,
          sources,
          siteManager:
            existing.siteManager ||
            linked.length > 0 ||
            group.some((row) => row.siteManager),
          revision: randomUUID(),
        }
      : personRecord(
          {
            ...first,
            primaryProgramId: first.programId || "",
            primaryProviderId:
              first.providerId ||
              rows.find(
                (row) =>
                  row.pk === `PROGRAM#${first.programId}` && row.sk === "#META",
              )?.providerId ||
              "",
            siteManager:
              group.some((row) => row.siteManager) || linked.length > 0,
          },
          personId,
          sources,
        );
    if (apply) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              personPut(person, existing?.revision),
              ...records.map((row) => ({
                Update: {
                  TableName: getDynamoTableName(),
                  Key: reference(row),
                  UpdateExpression: "SET personId = :person",
                  ConditionExpression: `attribute_exists(pk) AND ${row.personId ? "personId = :observedPerson" : "attribute_not_exists(personId)"} AND ${row.updatedAt ? "updatedAt = :updated" : "attribute_not_exists(updatedAt)"} AND ${row.staffSource ? "staffSource = :source" : "attribute_not_exists(staffSource)"}`,
                  ExpressionAttributeValues: {
                    ":person": personId,
                    ...(row.personId
                      ? { ":observedPerson": row.personId }
                      : {}),
                    ...(row.updatedAt ? { ":updated": row.updatedAt } : {}),
                    ...(row.staffSource ? { ":source": row.staffSource } : {}),
                  },
                },
              })),
            ],
          }),
        );
      } catch (error) {
        const reasons = error.CancellationReasons;
        if (
          error.name !== "TransactionCanceledException" ||
          !reasons?.some((item) => item.Code === "ConditionalCheckFailed") ||
          reasons.some(
            (item) =>
              item.Code &&
              !["None", "ConditionalCheckFailed"].includes(item.Code),
          )
        )
          throw error;
        conflicts.push({
          personId,
          sources: records.map(reference),
          reason: "conditional_conflict",
        });
        continue;
      }
    }
    migrated++;
  }
  return {
    mode: apply ? "apply" : "dry-run",
    mergeMatching: false,
    people: migrated,
    conflicts,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const report = await migratePeople({
    apply: process.argv.includes("--apply"),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts.length) process.exitCode = 1;
}
