import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";

/** Atomic closure plus a durable email outbox; the latest-version condition protects replacement periods.
 * @param {Record<string, any>} site
 * @param {Record<string, any>} term
 * @param {string} today
 * @param {string} now
 * @param {string} actor
 */
export async function closeComplianceTerms(site, term, today, now, actor) {
  const tableName = getDynamoTableName();
  const siteId = site.siteId;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        ...(term.email?.to
          ? [
              {
                Put: {
                  TableName: tableName,
                  Item: endedNoticeJob(site, term, now, actor),
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ]
          : []),
        {
          Update: {
            TableName: tableName,
            Key: { pk: term.pk, sk: term.sk },
            UpdateExpression:
              "SET expiresOnExclusive = :today, endedOn = :endDay, endedAt = :now, endedBy = :actor, #status = :ended",
            ConditionExpression:
              "attribute_not_exists(endedAt) AND #status <> :cancelled",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":today": today,
              ":endDay":
                actor === "scheduled-expiry" ? term.periodEnd || today : today,
              ":now": now,
              ":actor": actor,
              ":ended": "expired",
              ":cancelled": "cancelled",
            },
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: { pk: `SITE#${siteId}`, sk: "#META" },
            UpdateExpression:
              "SET compliance = :compliance, complianceTermsUpdatedAt = :now, updatedAt = :now, complianceLetters = :letters, letterState = :archived REMOVE latestComplianceTermsVersionId",
            ConditionExpression:
              "latestComplianceTermsVersionId = :version AND " +
              (site.complianceLetters
                ? "complianceLetters = :observedLetters"
                : "attribute_not_exists(complianceLetters)"),
            ExpressionAttributeValues: {
              ":compliance": {
                perimeterChecksRequired: false,
                underEnhancedMonitoring: false,
              },
              ":letters": {
                current: null,
                past: [
                  ...(site.complianceLetters?.current
                    ? [site.complianceLetters.current]
                    : []),
                  ...(site.complianceLetters?.past || []),
                ],
              },
              ":archived": "archived",
              ...(site.complianceLetters
                ? { ":observedLetters": site.complianceLetters }
                : {}),
              ":now": now,
              ":version": term.termsVersionId,
            },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `SITE#${siteId}`,
              sk: `AUDIT#${now}#${randomUUID()}`,
              type: "siteAuditEvent",
              eventType: "perimeter_checks_period_ended",
              siteId,
              termsVersionId: term.termsVersionId,
              actor,
              createdAt: now,
            },
          },
        },
      ],
    }),
  );
}

/** @param {Record<string, any>} site @param {Record<string, any>} term @param {string} now @param {string} actor */
export function endedNoticeJob(site, term, now, actor) {
  const letterJobId = `ended-${term.termsVersionId}`;
  return {
    pk: term.pk,
    sk: `LETTER_JOB#${letterJobId}`,
    type: "complianceRequirementEndedJob",
    entityType: "COMPLIANCE_LETTER_OUTBOX",
    siteId: site.siteId,
    letterJobId,
    termsVersionId: term.termsVersionId,
    status: "pending",
    noticeOnly: true,
    createdAt: now,
    createdBy: actor,
    email: {
      to: term.email.to,
      cc: term.email.cc || [],
      subject: `${process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX || ""}Perimeter check requirement ended`,
      text: `To the team at ${site.name || term.letterInputs?.siteName}:\n\nThe perimeter check requirement for your site at ${site.address || term.letterInputs?.siteAddress} has been ended. You are no longer required to conduct perimeter checks. Please contact your program manager if you have any concerns or questions.\n\nThank you for your participation in the Good Neighbor Policy.\n\n- The Good Neighbor Policy compliance team`,
    },
  };
}
