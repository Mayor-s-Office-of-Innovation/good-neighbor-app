import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import {
  emailHash,
  issueSetupCode,
  normalizeEmail,
  revokePendingSetupCodes,
  revokePendingSetupCodesForSite,
} from "./setup-codes.js";

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
  if (Array.isArray(groups)) return groups.includes("central-admin");
  if (typeof groups !== "string") return false;
  const value = groups.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) return false;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.includes("central-admin");
    } catch {
      // HTTP API JWT claims can stringify a group list without JSON quotes.
      // Match whole comma-delimited names, never substrings or words in a name.
      return value
        .slice(1, -1)
        .split(",")
        .some((group) => group.trim() === "central-admin");
    }
  }
  return value.split(",").some((group) => group.trim() === "central-admin");
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
    const providers = await queryAll({
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "PROVIDER_SEARCH#ACTIVE" },
      Limit: 100,
    });
    return jsonResponse(200, { providers });
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
    const memberships = await listProviderSiteMemberships(providerId);
    const activeMemberships = memberships.filter(
      (membership) => membership.status !== "inactive",
    );
    await deactivateProviderSites(providerId, activeMemberships, now);
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
    await Promise.all(
      activeMemberships.map((membership) =>
        cleanupDeactivatedSite(
          String(membership.siteId),
          "provider_deactivated",
          now,
        ),
      ),
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
    const providerSiteId = String(
      body.providerSiteId ?? `provider-site-${siteId}`,
    );
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
    const tableName = getDynamoTableName();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: site,
              ConditionExpression:
                "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: membership,
              ConditionExpression:
                "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: siteSearchItem(
                siteId,
                name,
                providerId,
                provider.Item.name,
                providerSiteId,
                now,
              ),
              ConditionExpression:
                "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          },
        ],
      }),
    );
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
    const tableName = getDynamoTableName();
    const siteRes = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = /** @type {any} */ (siteRes.Item);
    if (!site?.siteId) return jsonResponse(404, { error: "not_found" });

    const nextSite = {
      ...site,
      name,
      updatedAt: now,
    };
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const transactItems = [
      {
        Update: {
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          UpdateExpression: "SET #name = :name, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: { ":name": name, ":now": now },
        },
      },
    ];
    if (site.providerId) {
      transactItems.push({
        Update: {
          TableName: tableName,
          Key: { pk: `PROVIDER#${site.providerId}`, sk: `SITE#${siteId}` },
          UpdateExpression: "SET siteName = :name, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":name": name, ":now": now },
        },
      });
    }
    if (site.status !== "inactive") {
      const oldSearchSk = siteSearchSk(site.name, siteId);
      const nextSearchSk = siteSearchSk(name, siteId);
      if (oldSearchSk !== nextSearchSk) {
        transactItems.push({
          Delete: {
            TableName: tableName,
            Key: { pk: "SITE_SEARCH#ACTIVE", sk: oldSearchSk },
          },
        });
      }
      transactItems.push({
        Put: {
          TableName: tableName,
          Item: siteSearchItem(
            siteId,
            name,
            site.providerId,
            site.providerName,
            site.providerSiteId,
            now,
          ),
        },
      });
    }
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    return jsonResponse(200, { site: nextSite });
  });

/**
 * DELETE /admin/v1/sites/{siteId}
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const deactivateSite = (event) =>
  adminOnly(event, async () => {
    const siteId = event.pathParameters?.siteId ?? "";
    const now = new Date().toISOString();
    const tableName = getDynamoTableName();
    const siteRes = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    );
    const site = /** @type {any} */ (siteRes.Item);
    if (!site?.siteId) return jsonResponse(404, { error: "not_found" });

    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: `SITE#${siteId}`, sk: "#META" },
              UpdateExpression: "SET #status = :inactive, updatedAt = :now",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":inactive": "inactive",
                ":now": now,
              },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: {
                pk: "SITE_SEARCH#ACTIVE",
                sk: siteSearchSk(site.name, siteId),
              },
            },
          },
        ],
      }),
    );
    await cleanupDeactivatedSite(siteId, "site_deactivated", now);
    return jsonResponse(200, {
      site: {
        ...site,
        status: "inactive",
        updatedAt: now,
      },
    });
  });

export const listMasterContacts = contactLister("MASTER_CONTACT#");
export const createMasterContact = contactCreator(
  "MASTER_CONTACT#",
  "masterContact",
);
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
        siteName: issued.item.siteName,
        issuedTo: issued.item.issuedTo,
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
  return /** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */ (
    (event) =>
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
      })
  );
}

/**
 * @param {string} prefix
 * @param {string} type
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
function contactCreator(prefix, type) {
  return /** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */ (
    (event) =>
      adminOnly(event, async (body) => {
        const siteId = event.pathParameters?.siteId ?? "";
        const email = normalizeEmail(String(body.email ?? ""));
        if (!email) return jsonResponse(400, { error: "email_required" });
        const now = new Date().toISOString();
        const hash = await emailHash(email);
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
      })
  );
}

/**
 * @param {string} prefix
 * @returns {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
function contactDeactivator(prefix) {
  return /** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */ (
    (event) =>
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
        await revokePendingSetupCodes({
          siteId,
          contactHash: hash,
          reason: "contact_removed",
        });
        return jsonResponse(200, { contact: res.Attributes });
      })
  );
}

/**
 * @param {string} providerId
 * @returns {Promise<Record<string, unknown>[]>}
 */
function listProviderSiteMemberships(providerId) {
  return queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :site)",
    ExpressionAttributeValues: {
      ":pk": `PROVIDER#${providerId}`,
      ":site": "SITE#",
    },
  });
}

/**
 * @param {string} providerId
 * @param {Record<string, unknown>[]} memberships
 * @param {string} now
 * @returns {Promise<void>}
 */
async function deactivateProviderSites(providerId, memberships, now) {
  if (!memberships.length) return;

  await Promise.all(
    memberships.map((membership) => {
      const siteId = String(membership.siteId);
      return ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: getDynamoTableName(),
                Key: { pk: `SITE#${siteId}`, sk: "#META" },
                UpdateExpression: "SET #status = :inactive, updatedAt = :now",
                ConditionExpression: "attribute_exists(pk)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":inactive": "inactive",
                  ":now": now,
                },
              },
            },
            {
              Update: {
                TableName: getDynamoTableName(),
                Key: { pk: `PROVIDER#${providerId}`, sk: `SITE#${siteId}` },
                UpdateExpression: "SET #status = :inactive, updatedAt = :now",
                ConditionExpression: "attribute_exists(pk)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":inactive": "inactive",
                  ":now": now,
                },
              },
            },
            {
              Delete: {
                TableName: getDynamoTableName(),
                Key: {
                  pk: "SITE_SEARCH#ACTIVE",
                  sk: siteSearchSk(String(membership.siteName ?? ""), siteId),
                },
              },
            },
          ],
        }),
      );
    }),
  );
}

/**
 * @param {string} siteId
 * @param {string} reason
 * @param {string} now
 * @returns {Promise<void>}
 */
function cleanupDeactivatedSite(siteId, reason, now) {
  return Promise.all([
    revokePendingSetupCodesForSite({
      siteId,
      reason,
    }),
    revokeSiteDevices(siteId, now),
  ]).then(() => undefined);
}

/**
 * @param {string} siteId
 * @param {string} now
 * @returns {Promise<void>}
 */
async function revokeSiteDevices(siteId, now) {
  const devices = await queryAll({
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :device)",
    ExpressionAttributeValues: {
      ":pk": `SITE#${siteId}`,
      ":device": "DEVICE#",
    },
  });

  await Promise.all(
    devices.map((device) =>
      ddb.send(
        new UpdateCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `SITE#${siteId}`, sk: device.sk },
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
        }),
      ),
    ),
  );
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
 * @returns {Record<string, unknown>}
 */
function siteSearchItem(
  siteId,
  name,
  providerId,
  providerName,
  providerSiteId,
  now,
) {
  return {
    pk: "SITE_SEARCH#ACTIVE",
    sk: siteSearchSk(name, siteId),
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
  };
}

/**
 * @param {string} name
 * @param {string} siteId
 * @returns {string}
 */
function siteSearchSk(name, siteId) {
  return `${name.toLowerCase()}#${siteId}`;
}

/**
 * @param {Omit<import("@aws-sdk/lib-dynamodb").QueryCommandInput, "TableName">} input
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function queryAll(input) {
  /** @type {Record<string, unknown>[]} */
  const items = [];
  /** @type {Record<string, unknown> | undefined} */
  let exclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        ...input,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(res.Items ?? []));
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}
