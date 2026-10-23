import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";

const MAX_SITE_SEARCH_RESULTS = 25;

/**
 * GET /v1/sites:search?q=...
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const searchSites = async (event) => {
  const q = String(event.queryStringParameters?.q ?? "")
    .trim()
    .toLowerCase();
  if (q.length < 2) {
    return jsonResponse(200, { sites: [] });
  }

  /** @type {Record<string, unknown> | undefined} */
  let exclusiveStartKey;
  /** @type {any[]} */
  const items = [];
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "contains(searchText, :q)",
        ExpressionAttributeValues: {
          ":pk": "SITE_SEARCH#ACTIVE",
          ":q": q,
        },
        ExclusiveStartKey: exclusiveStartKey,
        Limit: MAX_SITE_SEARCH_RESULTS,
      }),
    );
    items.push(...(res.Items ?? []));
    exclusiveStartKey =
      items.length < MAX_SITE_SEARCH_RESULTS ? res.LastEvaluatedKey : undefined;
  } while (exclusiveStartKey);

  const sites = items.slice(0, MAX_SITE_SEARCH_RESULTS).map((item) => ({
    siteId: item.siteId,
    providerSiteId: item.providerSiteId,
    name: item.siteName,
    providerName: item.providerName,
    label: item.label,
  }));

  return jsonResponse(200, { sites });
};
