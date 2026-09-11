import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { normalizeExplicitShortCode } from "../lib/short-codes.js";
import { siteMetaKey } from "./keys.js";

/**
 * @typedef {object} ProviderSiteCodeItem
 * @property {string} pk
 * @property {string} sk
 * @property {"providerSiteCode"} type
 * @property {string} code
 * @property {boolean} active
 * @property {string} [providerId]
 * @property {string} [providerShortCode]
 * @property {string} providerSiteId
 * @property {string} siteId
 * @property {string} siteName
 * @property {string} [siteShortCode]
 */

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const handler = async (event) => {
  const body = parseJson(event.body);
  const code = normalizeSiteCode(
    typeof body?.code === "string" ? body.code : "",
  );

  if (!code) {
    return jsonResponse(400, { error: "missing_site_code" });
  }

  const res = await ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key: { pk: `SITE_CODE#${code}`, sk: "#META" },
    }),
  );

  const item = /** @type {ProviderSiteCodeItem | undefined} */ (res.Item);
  if (!item?.active || !item.siteId || !item.siteName) {
    return jsonResponse(401, { error: "invalid_site_code" });
  }

  await backfillSiteMetadata(getDynamoTableName(), item);

  return jsonResponse(200, {
    code,
    providerSite: {
      id: item.providerSiteId,
      siteId: item.siteId,
      name: item.siteName,
    },
  });
};

/**
 * @param {string} tableName
 * @param {ProviderSiteCodeItem} item
 * @returns {Promise<void>}
 */
async function backfillSiteMetadata(tableName, item) {
  const providerShortCode = normalizeExplicitShortCode(item.providerShortCode);
  const siteShortCode = normalizeExplicitShortCode(item.siteShortCode);
  if (!providerShortCode || !siteShortCode) return;

  await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: siteMetaKey(item.siteId),
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
        ":siteId": item.siteId,
        ":providerSiteId": item.providerSiteId,
        ":providerShortCode": providerShortCode,
        ":siteShortCode": siteShortCode,
        ":name": item.siteName,
        ":now": new Date().toISOString(),
        ...(item.providerId ? { ":providerId": item.providerId } : {}),
      },
    }),
  );
}

/**
 * @param {string | undefined} body
 * @returns {Record<string, unknown> | null}
 */
function parseJson(body) {
  if (!body) return null;
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Codes are stored as uppercase alphanumerics without visual separators, so
 * "123-456", "123 456", and "123456" resolve to the same provider site.
 * @param {string} code
 * @returns {string}
 */
export function normalizeSiteCode(code) {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}
