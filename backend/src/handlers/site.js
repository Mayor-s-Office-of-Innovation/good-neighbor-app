import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { siteMetaKey } from "./keys.js";

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
 * GET /v1/provider-sites — list active sites under the caller's provider.
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
  if (!providerId) {
    return jsonResponse(200, {
      providerId: "",
      providerName: String(site.providerName || ""),
      sites: [{ siteId, name: String(site.name || "Your site") }],
    });
  }

  const memberships = [];
  /** @type {any} */
  let cursor;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: dynamoTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PROVIDER#${providerId}`,
          ":prefix": "SITE#",
        },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    memberships.push(...(page.Items || []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  const activeMemberships = memberships.filter(
    (item) => item.status === "active" && item.siteId,
  );
  const verifiedSites = await Promise.all(
    activeMemberships.map(async (membership) => {
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
  const sites = verifiedSites
    .filter((site) => site !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return jsonResponse(200, {
    providerId,
    providerName: String(site.providerName || providerId),
    sites,
  });
};
