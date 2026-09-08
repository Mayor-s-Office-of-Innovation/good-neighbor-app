import { getConfig } from "../config.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  AnalyzerError,
  createAnalyzerClient,
} from "../analysis/analyzer-client.js";
import { supersedeOpenTasksForCondition } from "../analysis/guidance/guidance-store.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { analysisKey } from "./keys.js";

const APP_ID = "good-neighbor-app";

/** Max description length forwarded to the analyzer (matches artifact text). */
const MAX_DESCRIPTION_LENGTH = 4000;
/** Max reject-reason note length forwarded to the analyzer. */
const MAX_NOTE_LENGTH = 1000;

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
 * Resolve the stored analysis for a check artifact with one key-predicated read.
 *
 * Routes address the analysis by the coordinates the client already holds
 * (checkId + artifactId — both stamped on every evidence item), so this is a
 * single GetItem — NOT a partition-wide FilterExpression query. The analyzer's
 * `analysisId` is only an attribute on the ANALYSIS# item (the worker stores
 * what the analyzer returned), so resolving it from the item also guarantees
 * the analyzer always receives the server-stored ID, never a client-supplied
 * string. ConsistentRead mirrors completeCheck's rationale: the amendment is
 * external and non-repeatable, and a stale read that 404s a just-landed
 * analysis would surface as a spurious user-facing error.
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.checkId
 * @param {string} opts.artifactId
 * @returns {Promise<{ analysisId: string, checkId: string, artifactId: string } | null>}
 *   Null when the artifact has no ANALYSIS# item (not yet analyzed) or the item
 *   is a failed marker (no analysisId) — callers map null to 404.
 */
async function findAnalysisContext({ tableName, siteId, checkId, artifactId }) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: analysisKey(siteId, checkId, artifactId),
      ConsistentRead: true,
      ProjectionExpression: "checkId, artifactId, analysisId",
    }),
  );
  const item = result.Item;
  if (
    typeof item?.checkId !== "string" ||
    typeof item?.artifactId !== "string" ||
    typeof item?.analysisId !== "string" ||
    !item.analysisId
  ) {
    return null;
  }
  return {
    analysisId: item.analysisId,
    checkId: item.checkId,
    artifactId: item.artifactId,
  };
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
 * POST /v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
export async function editAnalysisCondition(event) {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { checkId, artifactId, conditionId } = event.pathParameters ?? {};
  if (!checkId || !artifactId || !conditionId) {
    return jsonResponse(400, {
      error: "Missing checkId, artifactId, or conditionId",
    });
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
  if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
    return jsonResponse(400, {
      error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
    });
  }

  try {
    const context = await findAnalysisContext({
      tableName: dynamoTable,
      siteId,
      checkId,
      artifactId,
    });
    if (!context) {
      return jsonResponse(404, { error: "Analysis not found" });
    }
    const client = await analyzerClient();
    const result = await client.editCondition(context.analysisId, conditionId, {
      description: description.trim(),
      appId: APP_ID,
      requestId: requestId(body, `${context.analysisId}#${conditionId}#edit`),
    });
    await supersedeAmendedConditionTasks({
      tableName: dynamoTable,
      siteId,
      analysisId: context.analysisId,
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
 * POST /v1/checks/{checkId}/artifacts/{artifactId}/conditions/{conditionId}/reject
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
export async function rejectAnalysisCondition(event) {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { checkId, artifactId, conditionId } = event.pathParameters ?? {};
  if (!checkId || !artifactId || !conditionId) {
    return jsonResponse(400, {
      error: "Missing checkId, artifactId, or conditionId",
    });
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
    const note =
      typeof input.reason.note === "string" ? input.reason.note.trim() : "";
    if (note.length > MAX_NOTE_LENGTH) {
      return jsonResponse(400, {
        error: `reason.note must be ${MAX_NOTE_LENGTH} characters or fewer`,
      });
    }
    reason = {
      key: input.reason.key,
      ...(note ? { note } : {}),
    };
  }

  try {
    const context = await findAnalysisContext({
      tableName: dynamoTable,
      siteId,
      checkId,
      artifactId,
    });
    if (!context) {
      return jsonResponse(404, { error: "Analysis not found" });
    }
    const client = await analyzerClient();
    const result = await client.rejectCondition(
      context.analysisId,
      conditionId,
      {
        ...(reason ? { reason } : {}),
        appId: APP_ID,
        requestId: requestId(
          body,
          `${context.analysisId}#${conditionId}#reject`,
        ),
      },
    );
    await supersedeAmendedConditionTasks({
      tableName: dynamoTable,
      siteId,
      analysisId: context.analysisId,
      conditionId,
      reason: "analysis_condition_rejected",
      context,
    });
    return jsonResponse(200, result);
  } catch (err) {
    return errorResponse(err);
  }
}
