import { getConfig } from "../config.js";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  AnalyzerError,
  createAnalyzerClient,
} from "../analysis/analyzer-client.js";
import { supersedeOpenTasksForCondition } from "../analysis/guidance/guidance-store.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { sitePk } from "./keys.js";

const APP_ID = "good-neighbor-app";

/**
 * @param {string} [message]
 * @returns {import("aws-lambda").APIGatewayProxyResult}
 */
function analyzerUnavailable(message = "Analyzer is not configured") {
  return jsonResponse(503, { error: message });
}

/**
 * @returns {Promise<import("../analysis/analyzer-client.js").AnalyzerClient>}
 */
async function analyzerClient() {
  const config = getConfig();
  if (!config.analyzerBaseUrl) {
    throw new Error("Missing ANALYZER_BASE_URL");
  }
  return createAnalyzerClient({
    baseUrl: config.analyzerBaseUrl,
    apiKey: await getAnalyzerApiKey(config),
  });
}

/**
 * @param {unknown} err
 * @returns {import("aws-lambda").APIGatewayProxyResult}
 */
function errorResponse(err) {
  if (err instanceof AnalyzerError) {
    return jsonResponse(err.status || 502, {
      error: err.message,
      code: err.code,
      details: err.details,
    });
  }
  if (err instanceof Error && /ANALYZER|Analyzer API key/.test(err.message)) {
    return analyzerUnavailable(err.message);
  }
  throw err;
}

/**
 * @param {unknown} body
 * @param {string} fallback
 * @returns {string}
 */
function requestId(body, fallback) {
  const caller =
    body && typeof body === "object" && "caller" in body
      ? /** @type {{ caller?: { request_id?: unknown } }} */ (body).caller
      : undefined;
  return typeof caller?.request_id === "string" && caller.request_id
    ? caller.request_id
    : fallback;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.analysisId
 * @returns {Promise<{ checkId: string, artifactId: string } | null>}
 */
async function findAnalysisContext({ tableName, siteId, analysisId }) {
  /** @type {Record<string, unknown> | undefined} */
  let exclusiveStartKey;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "#analysisId = :analysisId",
        ProjectionExpression: "checkId, artifactId, analysisId",
        ExpressionAttributeNames: { "#analysisId": "analysisId" },
        ExpressionAttributeValues: {
          ":pk": sitePk(siteId),
          ":analysisId": analysisId,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const item = result.Items?.[0];
    if (
      typeof item?.checkId === "string" &&
      typeof item.artifactId === "string"
    ) {
      return { checkId: item.checkId, artifactId: item.artifactId };
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.analysisId
 * @param {string} opts.conditionId
 * @param {string} opts.reason
 * @param {{ checkId: string, artifactId: string }} opts.context
 * @returns {Promise<void>}
 */
async function supersedeAmendedConditionTasks({
  tableName,
  siteId,
  analysisId,
  conditionId,
  reason,
  context,
}) {
  await supersedeOpenTasksForCondition({
    tableName,
    siteId,
    conditionId,
    checkId: context.checkId,
    assessmentIdPrefix: `${context.checkId}-${context.artifactId}`,
    analysisId,
    reason,
  });
}

/**
 * POST /v1/analyses/{analysisId}/conditions/{conditionId}
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
export async function editAnalysisCondition(event) {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { analysisId, conditionId } = event.pathParameters ?? {};
  if (!analysisId || !conditionId) {
    return jsonResponse(400, { error: "Missing analysisId or conditionId" });
  }

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const description =
    body && typeof body === "object"
      ? /** @type {{ description?: unknown }} */ (body).description
      : undefined;
  if (typeof description !== "string" || description.trim().length < 5) {
    return jsonResponse(400, {
      error: "Description must be at least 5 characters",
    });
  }

  try {
    const context = await findAnalysisContext({
      tableName: dynamoTable,
      siteId,
      analysisId,
    });
    if (!context) {
      return jsonResponse(404, { error: "Analysis not found" });
    }
    const client = await analyzerClient();
    const result = await client.editCondition(analysisId, conditionId, {
      description: description.trim(),
      appId: APP_ID,
      requestId: requestId(body, `${analysisId}#${conditionId}#edit`),
    });
    await supersedeAmendedConditionTasks({
      tableName: dynamoTable,
      siteId,
      analysisId,
      conditionId,
      reason: "analysis_condition_edited",
      context,
    });
    return jsonResponse(200, result);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /v1/analyses/{analysisId}/conditions/{conditionId}/reject
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
export async function rejectAnalysisCondition(event) {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { analysisId, conditionId } = event.pathParameters ?? {};
  if (!analysisId || !conditionId) {
    return jsonResponse(400, { error: "Missing analysisId or conditionId" });
  }

  let body = {};
  if (event.body) {
    try {
      body = readJsonBody(event) ?? {};
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }
  }
  const input = /** @type {{ reason?: { key?: unknown, note?: unknown } }} */ (
    body
  );
  /** @type {{ key: "not_a_problem" | "other", note?: string } | undefined} */
  let reason;
  if (input.reason !== undefined) {
    if (
      !input.reason ||
      typeof input.reason !== "object" ||
      (input.reason.key !== "not_a_problem" && input.reason.key !== "other")
    ) {
      return jsonResponse(400, {
        error: "reason.key must be one of: not_a_problem, other",
      });
    }
    reason = {
      key: input.reason.key,
      ...(typeof input.reason.note === "string" && input.reason.note.trim()
        ? { note: input.reason.note.trim() }
        : {}),
    };
  }

  try {
    const context = await findAnalysisContext({
      tableName: dynamoTable,
      siteId,
      analysisId,
    });
    if (!context) {
      return jsonResponse(404, { error: "Analysis not found" });
    }
    const client = await analyzerClient();
    const result = await client.rejectCondition(analysisId, conditionId, {
      ...(reason ? { reason } : {}),
      appId: APP_ID,
      requestId: requestId(body, `${analysisId}#${conditionId}#reject`),
    });
    await supersedeAmendedConditionTasks({
      tableName: dynamoTable,
      siteId,
      analysisId,
      conditionId,
      reason: "analysis_condition_rejected",
      context,
    });
    return jsonResponse(200, result);
  } catch (err) {
    return errorResponse(err);
  }
}
