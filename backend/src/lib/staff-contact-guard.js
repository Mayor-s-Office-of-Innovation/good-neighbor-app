import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";

/** A shared revision serializes new site-contact assignments with staff removal.
 * @param {string} tableName @param {string} programId @param {Record<string,any>} program
 */
export function contactRevisionChange(tableName, programId, program) {
  /** @type {Record<string, any>} */
  const values = {
    ":next": randomUUID(),
    ...(program.staffContactRevision
      ? { ":previous": program.staffContactRevision }
      : {}),
  };
  return {
    Update: {
      TableName: tableName,
      Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
      UpdateExpression: "SET staffContactRevision = :next",
      ConditionExpression: `attribute_exists(pk) AND ${program.staffContactRevision ? "staffContactRevision = :previous" : "attribute_not_exists(staffContactRevision)"}`,
      ExpressionAttributeValues: values,
    },
  };
}

/** Read the revision before checking all canonical site contacts, including inactive sites.
 * @param {string} tableName @param {string} programId @param {Record<string,any>} user
 */
export async function staffRemovalContactGuard(tableName, programId, user) {
  const { Item: program } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
      ConsistentRead: true,
    }),
  );
  if (!program) return { error: "program_not_found" };
  if (
    program.primaryContactUserId === user.userId ||
    (!program.primaryContactUserId &&
      program.contact?.email &&
      String(program.contact.email).trim().toLowerCase() ===
        String(user.email || "")
          .trim()
          .toLowerCase())
  )
    return { error: "program_primary_contact_in_use" };
  let cursor;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PROGRAM#${programId}`,
          ":prefix": "SITE#",
        },
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    for (const row of page.Items || []) {
      const { Item: site } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${row.siteId}`, sk: "#META" },
          ConsistentRead: true,
        }),
      );
      if (site?.primaryContactUserId === user.userId)
        return { error: "site_primary_contact_in_use" };
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const change = contactRevisionChange(tableName, programId, program);
  change.Update.ConditionExpression +=
    " AND (attribute_not_exists(primaryContactUserId) OR primaryContactUserId <> :userId)";
  change.Update.ExpressionAttributeValues[":userId"] = user.userId;
  // Legacy snapshot changes are covered by the same metadata version used by program edits.
  change.Update.ConditionExpression += program.updatedAt
    ? " AND updatedAt = :version"
    : " AND attribute_not_exists(updatedAt)";
  if (program.updatedAt)
    change.Update.ExpressionAttributeValues[":version"] = program.updatedAt;
  return { change };
}
