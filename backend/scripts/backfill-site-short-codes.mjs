import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { normalizeExplicitShortCode } from "../src/lib/short-codes.js";

const tableName = process.env.DYNAMO_TABLE;

if (!tableName) {
  console.error("[backfill] missing DYNAMO_TABLE");
  process.exit(1);
}

const docDdb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

backfillSiteShortCodes(docDdb, tableName)
  .then(({ scanned, updated, skipped }) => {
    console.log(
      `[backfill] scanned ${scanned} site codes, updated ${updated} sites, skipped ${skipped}`,
    );
  })
  .catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });

/**
 * @param {DynamoDBDocumentClient} ddb
 * @param {string} table
 * @returns {Promise<{ scanned: number, updated: number, skipped: number }>}
 */
async function backfillSiteShortCodes(ddb, table) {
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let ExclusiveStartKey;

  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey,
        FilterExpression:
          "#type = :type AND active = :active AND attribute_exists(siteId)",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: {
          ":type": "providerSiteCode",
          ":active": true,
        },
      }),
    );

    for (const item of page.Items ?? []) {
      scanned += 1;
      const siteId = String(item.siteId || "");
      const providerShortCode = normalizeExplicitShortCode(
        item.providerShortCode,
      );
      const siteShortCode = normalizeExplicitShortCode(item.siteShortCode);
      if (!siteId || !providerShortCode || !siteShortCode) {
        skipped += 1;
        continue;
      }

      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          UpdateExpression:
            "SET #type = if_not_exists(#type, :type), entityType = if_not_exists(entityType, :entityType), siteId = if_not_exists(siteId, :siteId), providerSiteId = if_not_exists(providerSiteId, :providerSiteId), providerShortCode = :providerShortCode, siteShortCode = :siteShortCode, #name = if_not_exists(#name, :name), updatedAt = :now" +
            (item.providerId
              ? ", providerId = if_not_exists(providerId, :providerId)"
              : ""),
          ExpressionAttributeNames: {
            "#type": "type",
            "#name": "name",
          },
          ExpressionAttributeValues: {
            ":type": "site",
            ":entityType": "SITE",
            ":siteId": siteId,
            ":providerSiteId": String(item.providerSiteId || ""),
            ":providerShortCode": providerShortCode,
            ":siteShortCode": siteShortCode,
            ":name": String(item.siteName || "Your site"),
            ":now": new Date().toISOString(),
            ...(item.providerId
              ? { ":providerId": String(item.providerId) }
              : {}),
          },
        }),
      );
      updated += 1;
    }

    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return { scanned, updated, skipped };
}
