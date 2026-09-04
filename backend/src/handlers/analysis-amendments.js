import { getConfig } from "../config.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  AnalyzerError,
  createAnalyzerClient,
} from "../analysis/analyzer-client.js";
import { jsonResponse, readJsonBody } from "../http.js";

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
 * POST /v1/analyses/{analysisId}/conditions/{conditionId}
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
export async function editAnalysisCondition(event) {
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
    const client = await analyzerClient();
    const result = await client.editCondition(analysisId, conditionId, {
      description: description.trim(),
      appId: APP_ID,
      requestId: requestId(body, `${analysisId}#${conditionId}#edit`),
    });
    return jsonResponse(200, result);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /v1/analyses/{analysisId}/conditions/{conditionId}/reject
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResult>}
 */
export async function rejectAnalysisCondition(event) {
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
  const reason =
    input.reason && typeof input.reason === "object"
      ? {
          key:
            input.reason.key === "other" ? "other" : "not_a_problem",
          ...(typeof input.reason.note === "string" && input.reason.note.trim()
            ? { note: input.reason.note.trim() }
            : {}),
        }
      : undefined;

  try {
    const client = await analyzerClient();
    const result = await client.rejectCondition(analysisId, conditionId, {
      ...(reason ? { reason } : {}),
      appId: APP_ID,
      requestId: requestId(body, `${analysisId}#${conditionId}#reject`),
    });
    return jsonResponse(200, result);
  } catch (err) {
    return errorResponse(err);
  }
}
