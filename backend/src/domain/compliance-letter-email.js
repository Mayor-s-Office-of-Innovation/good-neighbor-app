import { queryAllItems } from "../lib/query-all-items.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";

/** Snapshot recipients and copy so a resend uses the original message.
 * @param {Record<string, any>} site
 * @param {Record<string, any>} manager
 * @param {Record<string, any>} generator
 * @param {string} department
 */
export async function complianceLetterEmail(
  site,
  manager,
  generator,
  department,
) {
  const providerEmails = [];
  const providerManagerNames = [];
  /** @type {Record<string, any> | undefined} */
  let cursor;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PROVIDER#${site.providerId}`,
          ":prefix": "PROVIDER_MANAGER#",
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        ConsistentRead: true,
      }),
    );
    providerManagerNames.push(
      ...(result.Items || [])
        .filter((m) => m.status === "active")
        .map(
          (m) =>
            [m.firstName, m.lastName].filter(Boolean).join(" ") ||
            m.name ||
            m.email,
        )
        .filter(Boolean),
    );
    providerEmails.push(
      ...(result.Items || [])
        .filter((m) => m.status === "active")
        .map((m) => String(m.email || "")),
    );
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const siteEmails = [];
  if (site.siteId) {
    const { Items } = await queryAllItems({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `SITE#${site.siteId}` },
      ConsistentRead: true,
    });
    const members = Items.filter(
      (item) =>
        (item.sk.startsWith("MANAGER_MEMBERSHIP#") ||
          item.sk.startsWith("ASSIGNED_USER#")) &&
        item.status === "active",
    );
    for (const member of members) {
      if (member.userId && member.programId) {
        const result = await ddb.send(
          new GetCommand({
            TableName: getDynamoTableName(),
            Key: {
              pk: `PROGRAM#${member.programId}`,
              sk: `USER#${member.userId}`,
            },
            ConsistentRead: true,
          }),
        );
        if (result.Item?.status === "active")
          siteEmails.push(String(result.Item.email || ""));
      } else if (member.email) siteEmails.push(String(member.email));
    }
  }
  const to = String(manager.email).trim().toLowerCase();
  const cc = [
    ...new Set(
      [String(generator.email), ...providerEmails, ...siteEmails]
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email && email !== to),
    ),
  ];
  const text = `Dear ${manager.firstName},\n\nYour site's perimeter check requirements have been updated by ${generator.firstName} ${generator.lastName} at San Francisco's ${department}, under terms of the Good Neighbor Policy.\n\nThe attached letter describes the reason for the update and any new expectations for your perimeter checking.\n\nPlease reach out to your program manager directly if you have any questions.\n\nThank you for being a part of the Good Neighbor Policy and helping keep San Francisco's streets clean and safe for all.\n\n- Good Neighbor app team`;
  return {
    providerManagerNames: [...new Set(providerManagerNames)],
    to,
    cc,
    subject: `${process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX || ""}Good Neighbor perimeter check requirements — ${site.name}`,
    text,
  };
}
