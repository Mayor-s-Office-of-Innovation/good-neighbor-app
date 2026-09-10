import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { sendSetupCodeEmail } from "../integrations/email.js";
import {
  emailHash,
  genericSetupCodeRequestMessage,
  issueSetupCode,
  normalizeEmail,
} from "./setup-codes.js";

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

  const res = await ddb.send(
    new QueryCommand({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk",
      FilterExpression: "contains(searchText, :q)",
      ExpressionAttributeValues: {
        ":pk": "SITE_SEARCH#ACTIVE",
        ":q": q,
      },
      Limit: MAX_SITE_SEARCH_RESULTS,
    }),
  );

  const sites = (res.Items ?? []).map((item) => ({
    siteId: item.siteId,
    providerSiteId: item.providerSiteId,
    name: item.siteName,
    providerName: item.providerName,
    label: item.label,
  }));

  return jsonResponse(200, { sites });
};

/**
 * POST /v1/setup-codes:request
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const requestSetupCode = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const raw = /** @type {{ siteId?: unknown, email?: unknown }} */ (body ?? {});
  const siteId = typeof raw.siteId === "string" ? raw.siteId.trim() : "";
  const email = typeof raw.email === "string" ? normalizeEmail(raw.email) : "";
  if (!siteId || !isPlausibleEmail(email)) {
    return jsonResponse(400, { error: "invalid_request" });
  }

  const message = genericSetupCodeRequestMessage();
  const tableName = getDynamoTableName();
  const contactHash = emailHash(email);
  const [siteRes, codeContactRes, masterContactRes] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `CODE_CONTACT#${contactHash}` },
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: `MASTER_CONTACT#${contactHash}` },
      }),
    ),
  ]);

  const site = /** @type {any} */ (siteRes.Item);
  const contact =
    /** @type {any} */ (codeContactRes.Item) ??
    /** @type {any} */ (masterContactRes.Item);
  if (
    site?.siteId &&
    site.status !== "inactive" &&
    contact?.status === "active"
  ) {
    const issued = await issueSetupCode({
      siteId,
      siteName: site?.name ?? contact.siteName ?? "Good Neighbor site",
      providerId: site?.providerId,
      providerName: site?.providerName,
      providerSiteId: site?.providerSiteId,
      issuedTo: email,
      issuedBy: "provider-email-request",
    });
    await sendSetupCodeEmail({
      to: email,
      siteName: issued.item.siteName,
      code: issued.code,
      expiresAt: issued.item.expiresAt,
      appUrl: process.env.PROVIDER_APP_URL ?? "http://localhost:5173/",
    });
  }

  return jsonResponse(202, { message });
};

/**
 * @param {string} email
 * @returns {boolean}
 */
function isPlausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
