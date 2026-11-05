import { enrollmentLookupExpiry } from "./enrollment-retention.js";
import { checkCodeAttemptLimit } from "./code-attempt-limit.js";
import { enrollmentCodeVerifier } from "./enrollment-codes.js";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { normalizeExplicitShortCode } from "../lib/short-codes.js";
import { siteMetaKey } from "./keys.js";
import { validateSetupCode } from "./setup-codes.js";

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

  // Resolve manager invitations without consuming them. The normal login submit
  // redeems the grant, retaining its provider/site scope and single-use rules.
  if (/^[A-Z0-9]{6}$/.test(code)) {
    const limited = await checkCodeAttemptLimit(undefined, "lookup", event);
    if (limited) return limited;
    const hash = await enrollmentCodeVerifier(code);
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `ENROLLMENT_TOKEN#${hash}`, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    if (Item) {
      if (!Item.grantPk || !Item.grantSk)
        return jsonResponse(401, { error: "invalid_enrollment_grant" });
      const { Item: grant } = await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: Item.grantPk, sk: Item.grantSk },
          ConsistentRead: true,
        }),
      );
      if (
        !grant ||
        grant.grantId !== Item.grantId ||
        (grant.codeHash ||
          (grant.deliveryMode === "code" && grant.tokenHash)) !== hash
      )
        return jsonResponse(401, { error: "invalid_enrollment_grant" });
      const terminal =
        grant.status === "redeemed"
          ? "enrollment_already_used"
          : grant.status === "cancelled"
            ? "enrollment_cancelled"
            : grant.expiresAt <= new Date().toISOString()
              ? "enrollment_expired"
              : null;
      // Lazily give historical ISO lookup rows a bounded TTL too. Identity and
      // observed expiry are pinned so a concurrent retirement cannot be undone.
      if (typeof Item.expiresAt !== "number") {
        const at = grant.redeemedAt || grant.cancelledAt || grant.expiresAt;
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: getDynamoTableName(),
              Key: { pk: Item.pk || `ENROLLMENT_TOKEN#${hash}`, sk: "#META" },
              UpdateExpression: "SET expiresAt = :ttl",
              ConditionExpression: "grantId = :id AND expiresAt = :observed",
              ExpressionAttributeValues: {
                ":id": grant.grantId,
                ":observed": Item.expiresAt,
                ":ttl": enrollmentLookupExpiry(at),
              },
            }),
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== "ConditionalCheckFailedException"
          )
            throw error;
        }
      }
      if (terminal) return jsonResponse(410, { error: terminal });
      if (grant.status !== "pending")
        return jsonResponse(401, { error: "invalid_enrollment_grant" });
      return jsonResponse(200, { code, enrollment: true });
    }
  }

  const valid = await validateSetupCode(code);
  if (!valid) {
    return jsonResponse(401, { error: "invalid_site_code" });
  }

  if (valid.kind === "legacy") {
    await backfillSiteMetadata(
      getDynamoTableName(),
      /** @type {ProviderSiteCodeItem} */ (valid.item),
    );
  }

  return jsonResponse(200, {
    code,
    providerSite: {
      id: valid.providerSiteId,
      siteId: valid.siteId,
      name: valid.siteName,
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
