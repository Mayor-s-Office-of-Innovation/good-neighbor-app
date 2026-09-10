import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { emailHash, issueSetupCode, normalizeEmail } from "./setup-codes.js";

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {boolean}
 */
function isCentralAdmin(event) {
  const authorizer =
    /** @type {any} */ (event.requestContext)?.authorizer ?? {};
  const groups =
    authorizer.jwt?.claims?.["cognito:groups"] ??
    authorizer["claims.cognito:groups"] ??
    "";
  return String(groups).split(",").includes("central-admin");
}

/**
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {(body: Record<string, unknown>) => Promise<any>} fn
 * @returns {Promise<any>}
 */
async function adminOnly(event, fn) {
  if (!isCentralAdmin(event)) return jsonResponse(403, { error: "forbidden" });
  let body = /** @type {Record<string, unknown>} */ ({});
  if (event.body) {
    try {
      body = /** @type {Record<string, unknown>} */ (readJsonBody(event));
    } catch {
      return jsonResponse(400, { error: "invalid_json" });
    }
  }
  return fn(body);
}

/**
 * GET /admin/v1/providers
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const listProviders = (event) =>
  adminOnly(event, async () => {
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "PROVIDER_SEARCH#ACTIVE" },
        Limit: 100,
      }),
    );
    return jsonResponse(200, { providers: res.Items ?? [] });
  });

/**
 * POST /admin/v1/providers
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const createProvider = (event) =>
  adminOnly(event, async (body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const providerId = slug(body.providerId, name);
    const now = new Date().toISOString();
    const item = {
      pk: `PROVIDER#${providerId}`,
      sk: "#META",
      type: "provider",
      entityType: "PROVIDER",
      providerId,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      ),
      putProviderSearch(providerId, name, now),
    ]);
    return jsonResponse(201, { provider: item });
  });

/**
 * GET /admin/v1/providers/{providerId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const getProvider = (event) =>
  adminOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const [provider, sites] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new QueryCommand({
          TableName: getDynamoTableName(),
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :site)",
          ExpressionAttributeValues: {
            ":pk": `PROVIDER#${providerId}`,
            ":site": "SITE#",
          },
        }),
      ),
    ]);
    if (!provider.Item) return jsonResponse(404, { error: "not_found" });
    return jsonResponse(200, {
      provider: provider.Item,
      sites: sites.Items ?? [],
    });
  });

/**
 * PATCH /admin/v1/providers/{providerId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const updateProvider = (event) =>
  adminOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        UpdateExpression: "SET #name = :name, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":name": name, ":now": now },
        ReturnValues: "ALL_NEW",
      }),
    );
    await putProviderSearch(providerId, name, now);
    return jsonResponse(200, { provider: res.Attributes });
  });

/**
 * DELETE /admin/v1/providers/{providerId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const deactivateProvider = (event) =>
  adminOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        UpdateExpression: "SET #status = :inactive, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":inactive": "inactive",
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    await ddb.send(
      new DeleteCommand({
        TableName: getDynamoTableName(),
        Key: { pk: "PROVIDER_SEARCH#ACTIVE", sk: providerId },
      }),
    );
    return jsonResponse(200, { provider: res.Attributes });
  });

/**
 * POST /admin/v1/providers/{providerId}/sites
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const createSite = (event) =>
  adminOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const provider = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
      }),
    );
    if (!provider.Item || provider.Item.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    const siteId = slug(body.siteId, `${providerId}-${name}`);
    const providerSiteId = String(body.providerSiteId ?? `provider-site-${siteId}`);
    const now = new Date().toISOString();
    const site = {
      pk: `SITE#${siteId}`,
      sk: "#META",
      type: "site",
      entityType: "SITE",
      siteId,
      name,
      providerId,
      providerName: provider.Item.name,
      providerSiteId,
      status: "active",
      places: [],
      createdAt: now,
      updatedAt: now,
    };
    const membership = {
      pk: `PROVIDER#${providerId}`,
      sk: `SITE#${siteId}`,
      type: "providerSiteMembership",
      providerId,
      providerName: provider.Item.name,
      siteId,
      siteName: name,
      providerSiteId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: site,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      ),
      ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: membership,
        }),
      ),
      putSiteSearch(siteId, name, providerId, provider.Item.name, providerSiteId, now),
    ]);
    return jsonResponse(201, { site });
  });

/**
 * GET /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const getAdminSite = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `SITE#${siteId}` },
      }),
    );
    if (!res.Items?.length) return jsonResponse(404, { error: "not_found" });
    return jsonResponse(200, { items: res.Items });
  });

/**
 * PATCH /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const updateSite = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(400, { error: "name_required" });
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
        UpdateExpression: "SET #name = :name, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":name": name, ":now": now },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, { site: res.Attributes });
  });

/**
 * DELETE /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const deactivateSite = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
        UpdateExpression: "SET #status = :inactive, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":inactive": "inactive",
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, { site: res.Attributes });
  });

export const listMasterContacts = contactLister("MASTER_CONTACT#");
export const createMasterContact = contactCreator("MASTER_CONTACT#", "masterContact");
export const deactivateMasterContact = contactDeactivator("MASTER_CONTACT#");
export const listCodeContacts = contactLister("CODE_CONTACT#");
export const createCodeContact = contactCreator("CODE_CONTACT#", "codeContact");
export const deactivateCodeContact = contactDeactivator("CODE_CONTACT#");

/**
 * POST /admin/v1/sites/{siteId}/setup-codes
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const issueAdminSetupCode = (event) =>
  adminOnly(event, async (body) => {
    const siteId = event.pathParameters?.siteId ?? "";
    const email = normalizeEmail(String(body.email ?? ""));
    if (!email) return jsonResponse(400, { error: "email_required" });
    const siteRes = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = /** @type {any} */ (siteRes.Item);
    if (!site?.siteId || site.status === "inactive") {
      return jsonResponse(404, { error: "site_not_found" });
    }
    const issued = await issueSetupCode({
      siteId,
      siteName: site.name,
      providerId: site.providerId,
      providerName: site.providerName,
      providerSiteId: site.providerSiteId,
      issuedTo: email,
      issuedBy: "central-admin",
    });
    return jsonResponse(201, {
      setupCode: {
        code: issued.code,
        expiresAt: issued.item.expiresAt,
        maxUses: issued.item.maxUses,
        uses: issued.item.uses,
        siteId,
      },
    });
  });

/**
 * GET /admin/v1/sites/{siteId}/devices
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const listDevices = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :device)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":device": "DEVICE#",
        },
      }),
    );
    return jsonResponse(200, { devices: res.Items ?? [] });
  });

/**
 * DELETE /admin/v1/sites/{siteId}/devices/{deviceId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const revokeDevice = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const deviceId = event.pathParameters?.deviceId ?? "";
    const now = new Date().toISOString();
    const res = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `SITE#${siteId}`, sk: `DEVICE#${deviceId}` },
        UpdateExpression:
          "SET #status = :revoked, revokedAt = :now, updatedAt = :now, tokenGeneration = if_not_exists(tokenGeneration, :zero) + :one",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":revoked": "revoked",
          ":now": now,
          ":zero": 0,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, { device: res.Attributes });
  });

/**
 * @param {string} prefix
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
function contactLister(prefix) {
  return /** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */ ((event) =>
    adminOnly(event, async () => {
      const siteId = event.pathParameters?.siteId ?? "";
      const res = await ddb.send(
        new QueryCommand({
          TableName: getDynamoTableName(),
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `SITE#${siteId}`,
            ":prefix": prefix,
          },
        }),
      );
      return jsonResponse(200, { contacts: res.Items ?? [] });
    }));
}

/**
 * @param {string} prefix
 * @param {string} type
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
function contactCreator(prefix, type) {
  return /** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */ ((event) =>
    adminOnly(event, async (body) => {
      const siteId = event.pathParameters?.siteId ?? "";
      const email = normalizeEmail(String(body.email ?? ""));
      if (!email) return jsonResponse(400, { error: "email_required" });
      const now = new Date().toISOString();
      const hash = emailHash(email);
      const item = {
        pk: `SITE#${siteId}`,
        sk: `${prefix}${hash}`,
        type,
        email,
        emailHash: hash,
        name: String(body.name ?? "").trim() || undefined,
        siteId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      await ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: item,
        }),
      );
      return jsonResponse(201, { contact: item });
    }));
}

/**
 * @param {string} prefix
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
function contactDeactivator(prefix) {
  return /** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */ ((event) =>
    adminOnly(event, async () => {
      const siteId = event.pathParameters?.siteId ?? "";
      const hash = event.pathParameters?.emailHash ?? "";
      const now = new Date().toISOString();
      const res = await ddb.send(
        new UpdateCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `SITE#${siteId}`, sk: `${prefix}${hash}` },
          UpdateExpression: "SET #status = :inactive, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":inactive": "inactive",
            ":now": now,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return jsonResponse(200, { contact: res.Attributes });
    }));
}

/**
 * @param {unknown} provided
 * @param {string} fallback
 * @returns {string}
 */
function slug(provided, fallback) {
  const value = String(provided || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return value || randomUUID();
}

/**
 * @param {string} providerId
 * @param {string} name
 * @param {string} now
 * @returns {Promise<unknown>}
 */
function putProviderSearch(providerId, name, now) {
  return ddb.send(
    new PutCommand({
      TableName: getDynamoTableName(),
      Item: {
        pk: "PROVIDER_SEARCH#ACTIVE",
        sk: providerId,
        type: "providerSearch",
        providerId,
        name,
        searchText: name.toLowerCase(),
        status: "active",
        updatedAt: now,
      },
    }),
  );
}

/**
 * @param {string} siteId
 * @param {string} name
 * @param {string} providerId
 * @param {string} providerName
 * @param {string} providerSiteId
 * @param {string} now
 * @returns {Promise<unknown>}
 */
function putSiteSearch(siteId, name, providerId, providerName, providerSiteId, now) {
  return ddb.send(
    new PutCommand({
      TableName: getDynamoTableName(),
      Item: {
        pk: "SITE_SEARCH#ACTIVE",
        sk: `${name.toLowerCase()}#${siteId}`,
        type: "siteSearch",
        siteId,
        siteName: name,
        providerId,
        providerName,
        providerSiteId,
        label: `${name} (${providerName})`,
        searchText: `${name} ${providerName}`.toLowerCase(),
        status: "active",
        updatedAt: now,
      },
    }),
  );
}
