import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { queryAllItems } from "./query-all-items.js";
import { emailHash } from "../handlers/setup-codes.js";

/** Resolve shared staff's Site footprint, including retained memberships after program reassignment.
 * @param {string} programId @param {string} userId @param {string} email
 */
export async function managerSiteScope(programId, userId, email) {
  const TableName = getDynamoTableName();
  const hash = await emailHash(email);
  const [directory, programSites, activeSites] = await Promise.all([
    queryAllItems({
      TableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `MANAGER_EMAIL#${hash}` },
      ConsistentRead: true,
    }),
    queryAllItems({
      TableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `PROGRAM#${programId}`,
        ":prefix": "SITE#",
      },
      ConsistentRead: true,
    }),
    // Email and Lead program may both change while a stable-user membership
    // remains at an earlier Site. Include the active Site directory as well.
    queryAllItems({
      TableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "SITE_SEARCH#ACTIVE" },
      ConsistentRead: true,
    }),
  ]);
  const candidates = new Set(
    [...directory.Items, ...programSites.Items, ...activeSites.Items]
      .map((item) => String(item.siteId || ""))
      .filter(Boolean),
  );
  const siteIds = [];
  for (const siteId of candidates) {
    const [assignment, memberships] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName,
          Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
          ConsistentRead: true,
        }),
      ),
      queryAllItems({
        TableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "MANAGER_MEMBERSHIP#",
        },
        ConsistentRead: true,
      }),
    ]);
    if (
      (assignment.Item && assignment.Item.status !== "inactive") ||
      memberships.Items.some(
        (member) =>
          member.status === "active" &&
          ((member.userId === userId && member.programId === programId) ||
            (!member.userId &&
              String(member.email || "")
                .trim()
                .toLowerCase() === email.trim().toLowerCase())),
      )
    )
      siteIds.push(siteId);
  }
  return siteIds;
}
