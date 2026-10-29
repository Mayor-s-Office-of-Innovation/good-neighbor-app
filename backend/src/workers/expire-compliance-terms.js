import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { COMPLIANCE_TERMS_OPEN_PK, GSI3_NAME } from "../handlers/keys.js";
import { addDays, pacificToday } from "../lib/pacific-dates.js";
import { closeComplianceTerms } from "../domain/end-compliance-terms.js";

/**
 * End expired periods using Pacific dates, retaining the original recipient
 * snapshot. Reads the sparse GSI3 partition of open, end-dated terms versions:
 * one query bounded by today's date, whatever the table's size, instead of a
 * full-table scan.
 */
export async function expireComplianceTerms() {
  const today = pacificToday();
  const TableName = getDynamoTableName();
  /** @type {Record<string, any> | undefined} */
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName,
        IndexName: GSI3_NAME,
        // Sort keys are day-first (<expiresOnExclusive>#<siteId>#<versionId>),
        // so everything below tomorrow's day key expired on or before today.
        KeyConditionExpression: "gsi3pk = :open AND gsi3sk < :tomorrow",
        ExpressionAttributeValues: {
          ":open": COMPLIANCE_TERMS_OPEN_PK,
          ":tomorrow": addDays(today, 1),
        },
        ExclusiveStartKey,
      }),
    );
    for (const term of page.Items || []) {
      // The index is eventually consistent, so a version that ended or was
      // cancelled moments ago can still be listed. The close transaction would
      // refuse it anyway; skip the round trip.
      if (
        term.endedAt ||
        term.status === "cancelled" ||
        !term.expiresOnExclusive ||
        term.expiresOnExclusive > today
      )
        continue;
      const { Item: site } = await ddb.send(
        new GetCommand({
          TableName,
          Key: { pk: term.pk, sk: "#META" },
          ConsistentRead: true,
        }),
      );
      // Superseded terms must never announce that the replacement requirement ended.
      if (!site || site.latestComplianceTermsVersionId !== term.termsVersionId)
        continue;
      try {
        await closeComplianceTerms(
          site,
          term,
          term.expiresOnExclusive,
          new Date().toISOString(),
          "scheduled-expiry",
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "TransactionCanceledException"
        )
          throw error;
        // Concurrent cancellation, replacement, or letter update: the next sweep retries.
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}
