import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../db.js";
import { queryAllItems } from "./query-all-items.js";

/** Select the oldest assignment, treating access memberships and roster rows as
 * two projections of the same manager. Missing legacy dates sort first.
 * @param {Record<string, any>[]} rows @param {string} [preferredUserId]
 */
export function oldestSiteManager(rows, preferredUserId = "") {
  const sorted = rows
    .filter((row) => row.status !== "inactive")
    .sort(
      (a, b) =>
        String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
        Number(b.userId === preferredUserId) -
          Number(a.userId === preferredUserId) ||
        String(a.userId || a.membershipId || a.sk).localeCompare(
          String(b.userId || b.membershipId || b.sk),
        ),
    );
  const first = sorted[0];
  if (!first) return null;
  const email = String(first.email || "")
    .trim()
    .toLowerCase();
  const emailMatches = email
    ? sorted.filter(
        (row) =>
          String(row.email || "")
            .trim()
            .toLowerCase() === email,
      )
    : [];
  const emailUserIds = new Set(
    emailMatches.map((row) => row.userId).filter(Boolean),
  );
  const same = sorted.filter((row) => {
    if (first.userId && row.userId) return first.userId === row.userId;
    return (
      email &&
      emailUserIds.size <= 1 &&
      String(row.email || "")
        .trim()
        .toLowerCase() === email
    );
  });
  return {
    ...first,
    ...same.find((row) => row.sk?.startsWith("ASSIGNED_USER#")),
  };
}

/** Build an atomic contact update alongside a manager assignment mutation.
 * Read the revision BEFORE the roster; every roster writer advances it so a
 * concurrent assignment/removal fails the transaction instead of losing a primary.
 * @param {string} tableName @param {string} siteId @param {string} now
 * @param {{ add?: Record<string, any>, removeUserId?: string, removeMembershipId?: string, removeEmail?: string }} change
 */
export async function sitePrimaryContactChange(
  tableName,
  siteId,
  now,
  change = {},
) {
  const { Item: site } = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: "#META" },
      ConsistentRead: true,
    }),
  );
  const results = await Promise.all(
    ["ASSIGNED_USER#", "MANAGER_MEMBERSHIP#"].map((prefix) =>
      queryAllItems({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": prefix,
        },
        ConsistentRead: true,
      }),
    ),
  );
  const rows = results
    .flatMap((result) => result.Items || [])
    .filter(
      (row) =>
        !(change.removeUserId && row.userId === change.removeUserId) &&
        !(
          change.removeMembershipId &&
          row.membershipId === change.removeMembershipId
        ) &&
        !(
          change.removeEmail &&
          !row.userId &&
          String(row.email || "")
            .trim()
            .toLowerCase() === change.removeEmail.trim().toLowerCase()
        ),
    );
  if (change.add) rows.push(change.add);
  let primary = oldestSiteManager(rows, site?.primaryContactUserId);
  while (primary?.programId && primary?.userId) {
    const { Item: user } = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `PROGRAM#${primary.programId}`,
          sk: `USER#${primary.userId}`,
        },
        ConsistentRead: true,
      }),
    );
    if (!user && change.add?.userId === primary.userId) break;
    if (user?.status === "active") {
      primary = { ...primary, ...user };
      break;
    }
    const removedId = primary.userId;
    primary = oldestSiteManager(
      rows.filter((row) => row.userId !== removedId),
      site?.primaryContactUserId,
    );
    // Remove invalid staff from subsequent iterations as well.
    for (let i = rows.length - 1; i >= 0; i--)
      if (rows[i].userId === removedId) rows.splice(i, 1);
  }
  const revision = site?.managerRosterRevision;
  return {
    Update: {
      TableName: tableName,
      Key: { pk: `SITE#${siteId}`, sk: "#META" },
      UpdateExpression:
        "SET managerRosterRevision = :revision, updatedAt = :now" +
        (primary
          ? ", primaryContact = :contact" +
            (primary.userId
              ? ", primaryContactUserId = :userId"
              : " REMOVE primaryContactUserId")
          : " REMOVE primaryContactUserId, primaryContact"),
      ConditionExpression:
        "attribute_exists(pk) AND " +
        (site?.updatedAt === undefined
          ? "attribute_not_exists(updatedAt) AND "
          : "updatedAt = :expectedUpdatedAt AND ") +
        (revision === undefined
          ? "attribute_not_exists(managerRosterRevision)"
          : "managerRosterRevision = :expected"),
      ExpressionAttributeValues: {
        ":revision": randomUUID(),
        ...(site?.updatedAt === undefined
          ? {}
          : { ":expectedUpdatedAt": site.updatedAt }),
        ":now": now,
        ...(revision === undefined ? {} : { ":expected": revision }),
        ...(primary
          ? {
              ":contact": {
                firstName:
                  primary.firstName || String(primary.name || "").split(" ")[0],
                lastName:
                  primary.lastName ||
                  String(primary.name || "")
                    .split(" ")
                    .slice(1)
                    .join(" "),
                email: primary.email || "",
                phone: primary.phone || "",
                phoneExtension: primary.phoneExtension || "",
              },
              ...(primary.userId ? { ":userId": primary.userId } : {}),
            }
          : {}),
      },
    },
  };
}
