import { GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";
import { pacificToday } from "../lib/pacific-dates.js";
import { closeComplianceTerms } from "../domain/end-compliance-terms.js";

/** End expired periods using Pacific dates, retaining the original recipient snapshot. */
export async function expireComplianceTerms() {
  const today = pacificToday();
  const TableName = getDynamoTableName();
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").ScanCommandOutput} */
    const page = await ddb.send(
      new ScanCommand({
        TableName,
        ExclusiveStartKey,
        FilterExpression:
          "entityType = :type AND expiresOnExclusive <= :today AND attribute_not_exists(endedAt) AND #status <> :cancelled",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":type": "COMPLIANCE_TERMS",
          ":today": today,
          ":cancelled": "cancelled",
        },
      }),
    );
    for (const term of page.Items || []) {
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
