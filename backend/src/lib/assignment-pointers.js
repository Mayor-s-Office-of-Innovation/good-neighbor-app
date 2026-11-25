// Reverse index for program-staff Site assignments. An assignment lives under
// the Site (`SITE#<site>/ASSIGNED_USER#<user>`), which answers "who is at this
// Site" but not "which Sites is this person at". Every writer that creates or
// deletes an assignment also writes or deletes this pointer in the same
// transaction, so the second question is one query:
//   PROGRAM#<program> / USER_SITE#<user>#<site>
// Manager memberships already have their own reverse pointers.
// backend/scripts/migrate-assignment-pointers.mjs backfills and repairs them.

import { queryAllItems } from "./query-all-items.js";

/** @param {string} programId @param {string} userId @param {string} siteId */
export function assignmentPointerKey(programId, userId, siteId) {
  return {
    pk: `PROGRAM#${programId}`,
    sk: `USER_SITE#${userId}#${siteId}`,
  };
}

/**
 * Transaction item that records an assignment's pointer. Idempotent.
 * @param {string} tableName
 * @param {{ programId: string, userId: string, siteId: string, now: string }} assignment
 */
export function assignmentPointerPut(
  tableName,
  { programId, userId, siteId, now },
) {
  return {
    Put: {
      TableName: tableName,
      Item: {
        ...assignmentPointerKey(programId, userId, siteId),
        type: "programUserSitePointer",
        programId,
        userId,
        siteId,
        createdAt: now,
      },
    },
  };
}

/**
 * Transaction item that removes an assignment's pointer. Idempotent.
 * @param {string} tableName
 * @param {{ programId: string, userId: string, siteId: string }} assignment
 */
export function assignmentPointerDelete(
  tableName,
  { programId, userId, siteId },
) {
  return {
    Delete: {
      TableName: tableName,
      Key: assignmentPointerKey(programId, userId, siteId),
    },
  };
}

/**
 * Every Site this program-staff person is assigned to.
 * @param {string} tableName @param {string} programId @param {string} userId
 * @returns {Promise<string[]>}
 */
export async function assignedSiteIds(tableName, programId, userId) {
  const { Items } = await queryAllItems({
    TableName: tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": `PROGRAM#${programId}`,
      ":prefix": `USER_SITE#${userId}#`,
    },
    ConsistentRead: true,
  });
  return Items.map((item) => String(item.siteId || "")).filter(Boolean);
}
