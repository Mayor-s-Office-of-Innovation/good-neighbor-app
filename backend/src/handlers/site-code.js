import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";

/**
 * @typedef {object} ProviderSiteCodeItem
 * @property {string} pk
 * @property {string} sk
 * @property {"providerSiteCode"} type
 * @property {string} code
 * @property {boolean} active
 * @property {string} providerSiteId
 * @property {string} siteId
 * @property {string} siteName
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
