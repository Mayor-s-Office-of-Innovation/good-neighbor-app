import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { siteMetaKey } from "./keys.js";

const PROVIDER_SITES_PAGE_SIZE = 25;
const SITE_METADATA_CONCURRENCY = 5;

/**
 * A cursor can select only a later membership in the caller's own provider
 * partition; the provider key itself is always derived from the bound site.
 * @param {string} value
 * @returns {string | null}
 */
function decodeMembershipCursor(value) {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const sk = Buffer.from(value, "base64url").toString("utf8");
  if (
    !sk.startsWith("SITE#") ||
    sk.length > 256 ||
    Array.from(sk).some((character) => character.charCodeAt(0) < 32) ||
    Buffer.from(sk).toString("base64url") !== value
  ) {
    return null;
  }
  return sk;
}

/**
 * GET /v1/site — the bound site's metadata (`SITE#<id>` / `#META`). Returns a
 * minimal default record when nothing has been written yet so the client
 * always has a name to show.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getSite = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const result = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: siteMetaKey(siteId),
    }),
  );

  const site = result.Item || {
    ...siteMetaKey(siteId),
    type: "site",
    siteId,
    name: "Your site",
  };
  return jsonResponse(200, { site });
};

/**
 * GET /v1/provider-sites — page through active sites under the caller's provider.
 * The provider is read from the authenticated site's metadata, never from a
 * request parameter, so a device cannot enumerate another provider's sites.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const listProviderSites = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const current = await ddb.send(
    new GetCommand({ TableName: dynamoTable, Key: siteMetaKey(siteId) }),
  );
  const site = current.Item;
  if (!site || site.status === "inactive") {
    return jsonResponse(404, { error: "site_not_found" });
  }
  const providerId = String(site.providerId || "");
  const rawCursor = event.queryStringParameters?.cursor || "";
  const cursorSk = rawCursor ? decodeMembershipCursor(rawCursor) : "";
  if (rawCursor && !cursorSk) {
    return jsonResponse(400, { error: "invalid_cursor" });
  }
  if (!providerId) {
    return jsonResponse(200, {
      providerId: "",
      providerName: String(site.providerName || ""),
      sites: [{ siteId, name: String(site.name || "Your site") }],
      nextCursor: null,
    });
  }

  const providerKey = `PROVIDER#${providerId}`;
  const page = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": providerKey,
        ":prefix": "SITE#",
      },
      Limit: PROVIDER_SITES_PAGE_SIZE,
      ...(cursorSk
        ? { ExclusiveStartKey: { pk: providerKey, sk: cursorSk } }
        : {}),
    }),
  );

  const activeMemberships = (page.Items || []).filter(
    (item) => item.status === "active" && item.siteId,
  );
  /** @type {{ siteId: string, name: string }[]} */
  const verifiedSites = [];
  for (
    let index = 0;
    index < activeMemberships.length;
    index += SITE_METADATA_CONCURRENCY
  ) {
    const group = await Promise.all(
      activeMemberships
        .slice(index, index + SITE_METADATA_CONCURRENCY)
        .map(async (membership) => {
          const memberSiteId = String(membership.siteId);
          const result = await ddb.send(
            new GetCommand({
              TableName: dynamoTable,
              Key: siteMetaKey(memberSiteId),
            }),
          );
          const metadata = result.Item;
          if (
            !metadata ||
            metadata.status === "inactive" ||
            String(metadata.providerId || "") !== providerId
          ) {
            return null;
          }
          return {
            siteId: memberSiteId,
            name: String(metadata.name || membership.siteName || memberSiteId),
          };
        }),
    );
    verifiedSites.push(...group.filter((member) => member !== null));
  }
  const sites = verifiedSites.sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse(200, {
    providerId,
    providerName: String(site.providerName || providerId),
    sites,
    nextCursor: page.LastEvaluatedKey?.sk
      ? Buffer.from(String(page.LastEvaluatedKey.sk)).toString("base64url")
      : null,
  });
};
