import { QueryCommand } from "@aws-sdk/lib-dynamodb";
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
    providerEmails.push(
      ...(result.Items || [])
        .filter((m) => m.status === "active")
        .map((m) => String(m.email || "")),
    );
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const to = String(manager.email).trim().toLowerCase();
  const cc = [
    ...new Set(
      [String(generator.email), ...providerEmails]
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email && email !== to),
    ),
  ];
  const text = `Dear ${manager.firstName},\n\nYour site's perimeter check requirements have been updated by ${generator.firstName} ${generator.lastName} at San Francisco's ${department}, under terms of the Good Neighbor Policy. The attached letter describes the reason for the update and any new expectations for your perimeter checking.\n\nPlease reach out to your program manager directly if you have any questions.\n\nThank you for being a part of the Good Neighbor Policy and helping keep San Francisco's streets clean and safe for all.\n\n-Good Neighbor app team-`;
  return {
    to,
    cc,
    subject: `${process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX || ""}Good Neighbor perimeter check requirements — ${site.name}`,
    text,
  };
}
