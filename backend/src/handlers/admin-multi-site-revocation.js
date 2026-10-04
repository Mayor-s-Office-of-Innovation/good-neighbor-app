import { randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getConfig, getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { adminOnly } from "../lib/admin-auth.js";

const sqs = new SQSClient({});
const MAX_SITES = 20;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listEmergencyRevocationSites = (event) =>
  adminOnly(event, async () => {
    const sites = await queryActiveSites(getDynamoTableName());
    return jsonResponse(200, {
      sites: sites.map((site) => ({
        siteId: site.siteId,
        siteName: site.siteName,
        providerId: site.providerId,
        providerName: site.providerName,
        status: site.status,
      })),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const previewEmergencySiteRevocation = (event) =>
  adminOnly(event, async (body) => {
    const siteIds = validSiteIds(body.siteIds);
    if (!siteIds) return jsonResponse(400, { error: "invalid_site_selection" });
    const sites = await loadSitesWithBindings(getDynamoTableName(), siteIds);
    if (!sites) return jsonResponse(404, { error: "site_not_found" });
    return jsonResponse(200, {
      confirmation: confirmationPhrase(sites.length),
      sites: sites.map(publicSitePreview),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const startEmergencySiteRevocation = (event) =>
  adminOnly(event, async (body) => {
    const siteIds = validSiteIds(body.siteIds);
    if (!siteIds) return jsonResponse(400, { error: "invalid_site_selection" });
    const tableName = getDynamoTableName();
    const sites = await loadSitesWithBindings(tableName, siteIds);
    if (!sites) return jsonResponse(404, { error: "site_not_found" });
    if (String(body.confirmation ?? "") !== confirmationPhrase(sites.length)) {
      return jsonResponse(400, { error: "confirmation_mismatch" });
    }

    const operationId = randomUUID();
    const startedAt = new Date().toISOString();
    const actor = actorId(event);
    const operationPk = `REVOCATION_OPERATION#${operationId}`;
    const items = sites.flatMap((site) => {
      const nextGeneration = Number(site.siteCredentialGeneration ?? 0) + 1;
      return [
        {
          Update: {
            TableName: tableName,
            Key: { pk: `SITE#${site.siteId}`, sk: "#META" },
            UpdateExpression:
              "SET siteCredentialGeneration = :next, updatedAt = :now",
            ConditionExpression:
              "attribute_exists(pk) AND #status = :active AND (attribute_not_exists(siteCredentialGeneration) OR siteCredentialGeneration = :current)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":active": "active",
              ":current": Number(site.siteCredentialGeneration ?? 0),
              ":next": nextGeneration,
              ":now": startedAt,
            },
          },
        },
        putItem(tableName, {
          pk: `SITE#${site.siteId}`,
          sk: `REVOCATION_OPERATION#${startedAt}#${operationId}`,
          type: "revocationOperation",
          operationId,
          scope: "multi_site",
          siteId: site.siteId,
          siteCredentialGeneration: nextGeneration,
          requestedCount: site.bindings.length,
          status: "queued",
          actor,
          createdAt: startedAt,
        }),
        putItem(tableName, {
          pk: `SITE#${site.siteId}`,
          sk: `AUDIT#${startedAt}#${randomUUID()}`,
          type: "siteAuditEvent",
          eventType: "emergency_multi_site_revocation_started",
          siteId: site.siteId,
          operationId,
          siteCredentialGeneration: nextGeneration,
          requestedCount: site.bindings.length,
          actor,
          createdAt: startedAt,
        }),
      ];
    });
    items.push(
      putItem(tableName, {
        pk: operationPk,
        sk: "#META",
        type: "revocationOperation",
        operationId,
        scope: "multi_site",
        siteIds,
        requestedSiteCount: sites.length,
        queuedSiteCount: 0,
        enqueueFailedCount: 0,
        completedSiteCount: 0,
        partialSiteCount: 0,
        status: "starting",
        actor,
        createdAt: startedAt,
      }),
    );
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isTransactionConflict(error)) {
        return jsonResponse(409, { error: "multi_site_revocation_conflict" });
      }
      throw error;
    }

    const queueUrl = getConfig().queueUrl;
    const queued = await Promise.allSettled(
      sites.map((site) =>
        sqs.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify({
              type: "reconcile_site_revocation",
              operationId,
              operationPk,
              siteId: site.siteId,
              startedAt,
              actor,
            }),
          }),
        ),
      ),
    );
    const enqueueFailedCount = queued.filter(
      (result) => result.status === "rejected",
    ).length;
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk: operationPk, sk: "#META" },
        UpdateExpression:
          "SET #status = :status, queuedSiteCount = :queued, enqueueFailedCount = :failed, enqueueCompletedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": enqueueFailedCount ? "partial" : "applying",
          ":queued": sites.length - enqueueFailedCount,
          ":failed": enqueueFailedCount,
          ":now": new Date().toISOString(),
        },
      }),
    );
    if (enqueueFailedCount) {
      console.error(
        JSON.stringify({
          marker: "RevocationOperationPartial",
          level: "ERROR",
          operationId,
          enqueueFailedCount,
        }),
      );
    }
    return jsonResponse(202, {
      operationId,
      status: enqueueFailedCount ? "partial" : "applying",
      affectedSiteCount: sites.length,
      queuedSiteCount: sites.length - enqueueFailedCount,
      enqueueFailedCount,
    });
  });

/** @param {unknown} value */
function validSiteIds(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_SITES) {
    return null;
  }
  const ids = value.map((item) => String(item ?? "").trim());
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[A-Za-z0-9_-]{1,100}$/.test(id))
  ) {
    return null;
  }
  return ids;
}

/** @param {string} tableName @param {string[]} siteIds @returns {Promise<Array<Record<string, any>> | null>} */
async function loadSitesWithBindings(tableName, siteIds) {
  const sites = await Promise.all(
    siteIds.map(async (siteId) => {
      const [siteResult, bindingsResult, legacyResult] = await Promise.all([
        ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: `SITE#${siteId}`, sk: "#META" },
            ConsistentRead: true,
          }),
        ),
        querySiteRows(tableName, siteId, "DEVICE_BINDING#"),
        querySiteRows(tableName, siteId, "DEVICE#"),
      ]);
      const site = siteResult.Item;
      if (!site || site.status !== "active") return null;
      const bindings = bindingsResult.filter(
        (binding) => binding.status !== "revoked",
      );
      const canonicalIds = new Set(
        bindings.map((binding) => binding.bindingId),
      );
      const legacyOnly = legacyResult
        .filter(
          (device) =>
            device.status !== "revoked" &&
            !canonicalIds.has(device.bindingId ?? device.deviceId),
        )
        .map((device) => ({
          ...device,
          bindingId: device.bindingId ?? device.deviceId,
          legacy: true,
        }));
      return {
        ...site,
        bindings: [...bindings, ...legacyOnly],
      };
    }),
  );
  if (sites.some((site) => !site)) return null;
  /** @type {Array<Record<string, any>>} */
  const found = [];
  for (const site of sites) {
    if (site) found.push(site);
  }
  return found;
}

/** @param {string} tableName */
async function queryActiveSites(tableName) {
  const items = [];
  let cursor;
  do {
    const result =
      /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */ (
        await ddb.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "pk = :pk",
            ExpressionAttributeValues: { ":pk": "SITE_SEARCH#ACTIVE" },
            ProjectionExpression:
              "siteId, siteName, providerId, providerName, #status",
            ExpressionAttributeNames: { "#status": "status" },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        )
      );
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items;
}

/** @param {string} tableName @param {string} siteId @param {string} prefix */
async function querySiteRows(tableName, siteId, prefix) {
  const items = [];
  let cursor;
  do {
    const result =
      /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */ (
        await ddb.send(
          new QueryCommand({
            TableName: tableName,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
            ExpressionAttributeValues: {
              ":pk": `SITE#${siteId}`,
              ":prefix": prefix,
            },
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        )
      );
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items;
}

/** @param {Record<string, any>} site */
function publicSitePreview(site) {
  return {
    siteId: site.siteId,
    siteName: site.name,
    bindings: site.bindings.map(
      (/** @type {Record<string, any>} */ binding) => ({
        bindingId: binding.bindingId,
        label: binding.label,
        accessLevel: binding.accessLevel,
        status: binding.status,
        ...(binding.legacy ? { legacy: true } : {}),
      }),
    ),
  };
}

/** @param {number} count */
function confirmationPhrase(count) {
  return `REVOKE ${count} SITES`;
}

/** @param {string} tableName @param {Record<string, unknown>} item */
function putItem(tableName, item) {
  return { Put: { TableName: tableName, Item: item } };
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
function actorId(event) {
  const requestContext = /** @type {any} */ (event.requestContext);
  return String(requestContext.authorizer?.jwt?.claims?.sub ?? "unknown-admin");
}

/** @param {unknown} error */
function isTransactionConflict(error) {
  return (
    error instanceof Error &&
    [
      "ConditionalCheckFailedException",
      "TransactionCanceledException",
      "TransactionConflictException",
    ].includes(error.name)
  );
}
