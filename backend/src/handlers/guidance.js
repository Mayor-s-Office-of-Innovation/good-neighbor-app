import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import {
  answerCondition,
  completeTaskWithAppActions,
  getAssessmentGuidance,
  markTaskCannotDo,
  storeEvaluatedAssessment,
} from "../analysis/guidance/guidance-store.js";

/**
 * @param {unknown} body
 * @returns {{ assessmentId: string, checkId?: string, reportedAt: string, rubricVersion?: string, grade?: string | null, rawAssessment: Record<string, unknown>, conditions: import("../analysis/guidance/guidance-store.js").AssessmentConditionInput[] }}
 */
function normalizeAssessmentBody(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Expected JSON object body");
  }
  const input = /** @type {Record<string, unknown>} */ (body);
  const rawAssessment = /** @type {Record<string, unknown>} */ (
    input.rawAssessment && typeof input.rawAssessment === "object"
      ? input.rawAssessment
      : input
  );

  const assessment =
    input.assessment && typeof input.assessment === "object"
      ? /** @type {Record<string, unknown>} */ (input.assessment)
      : undefined;
  const metadata =
    assessment?.metadata && typeof assessment.metadata === "object"
      ? /** @type {Record<string, unknown>} */ (assessment.metadata)
      : {};
  const general =
    assessment?.general_conditions && typeof assessment.general_conditions === "object"
      ? /** @type {Record<string, unknown>} */ (assessment.general_conditions)
      : {};

  const explicitConditions = Array.isArray(input.conditions)
    ? /** @type {unknown[]} */ (input.conditions)
    : undefined;
  const analyzerConditions = Array.isArray(
    assessment?.identified_conditions_of_concern,
  )
    ? /** @type {unknown[]} */ (assessment.identified_conditions_of_concern)
    : undefined;

  const sourceConditions = explicitConditions ?? analyzerConditions;
  if (!sourceConditions) {
    throw new Error("Expected conditions[] or assessment.identified_conditions_of_concern[]");
  }

  const conditions = sourceConditions.map((condition, index) => {
    const item = /** @type {Record<string, unknown>} */ (condition);
    const category = item.category;
    const severity = item.severity ?? item.rating;
    if (typeof category !== "string" || typeof severity !== "number") {
      throw new Error(`Invalid condition at index ${index}`);
    }
    return {
      conditionId:
        typeof item.conditionId === "string" ? item.conditionId : undefined,
      category,
      severity,
      severityLabel:
        typeof item.severity_label === "string"
          ? item.severity_label
          : typeof item.severityLabel === "string"
            ? item.severityLabel
            : undefined,
      description:
        typeof item.description === "string"
          ? item.description
          : typeof item.explanation === "string"
            ? item.explanation
            : undefined,
      sourceArtifactIds: Array.isArray(item.sourceArtifactIds)
        ? item.sourceArtifactIds.filter((id) => typeof id === "string")
        : [],
      evidenceIndices: Array.isArray(item.evidence_indices)
        ? item.evidence_indices.filter((id) => typeof id === "number")
        : Array.isArray(item.evidenceIndices)
          ? item.evidenceIndices.filter((id) => typeof id === "number")
          : [],
      source: {
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        positionDescriptor: metadata.position_descriptor,
      },
    };
  });

  const reportedAt =
    typeof input.reportedAt === "string"
      ? input.reportedAt
      : typeof metadata.reported_at === "string"
        ? metadata.reported_at
        : new Date().toISOString();

  return {
    assessmentId:
      typeof input.assessmentId === "string" ? input.assessmentId : randomUUID(),
    checkId: typeof input.checkId === "string" ? input.checkId : undefined,
    reportedAt,
    rubricVersion:
      typeof input.rubricVersion === "string" ? input.rubricVersion : undefined,
    grade: typeof general.label === "string" ? general.label : null,
    rawAssessment,
    conditions,
  };
}

/**
 * POST /v1/assessments:evaluate
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const evaluateAssessment = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  let input;
  try {
    input = normalizeAssessmentBody(body);
  } catch (err) {
    return jsonResponse(400, { error: /** @type {Error} */ (err).message });
  }

  try {
    const result = await storeEvaluatedAssessment(
      { siteId, ...input },
      { tableName: dynamoTable },
    );
    return jsonResponse(201, {
      assessment: result.assessmentItem,
      conditions: result.conditionItems,
      tasks: result.taskItems,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      const existing = await getAssessmentGuidance({
        tableName: dynamoTable,
        siteId,
        assessmentId: input.assessmentId,
      });
      return jsonResponse(200, existing);
    }
    throw err;
  }
};

/**
 * GET /v1/assessments/{assessmentId}/guidance
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getGuidance = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const assessmentId = event.pathParameters?.assessmentId;
  if (!assessmentId) return jsonResponse(400, { error: "Missing assessmentId" });

  const result = await getAssessmentGuidance({
    tableName: dynamoTable,
    siteId,
    assessmentId,
  });
  if (!result.assessment) return jsonResponse(404, { error: "Assessment not found" });
  return jsonResponse(200, result);
};

/**
 * POST /v1/assessments/{assessmentId}/conditions/{conditionId}/answers
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const submitConditionAnswers = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { assessmentId, conditionId } = event.pathParameters ?? {};
  if (!assessmentId || !conditionId) {
    return jsonResponse(400, { error: "Missing assessmentId or conditionId" });
  }

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const answers = /** @type {{ answers?: unknown }} */ (body ?? {}).answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return jsonResponse(400, { error: "Expected answers object" });
  }

  try {
    const result = await answerCondition({
      tableName: dynamoTable,
      siteId,
      assessmentId,
      conditionId,
      answers: /** @type {Record<string, unknown>} */ (answers),
    });
    return jsonResponse(200, result);
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") {
      return jsonResponse(404, { error: "Condition not found" });
    }
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      return jsonResponse(409, { error: "Condition is not awaiting answers" });
    }
    throw err;
  }
};

/**
 * POST /v1/tasks/{taskId}/cannot-do
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const cannotDoTask = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = event.pathParameters?.taskId;
  if (!taskId) return jsonResponse(400, { error: "Missing taskId" });

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  const { reason, note } = /** @type {{ reason?: unknown, note?: unknown }} */ (
    body ?? {}
  );
  if (typeof reason !== "string" || !reason) {
    return jsonResponse(400, { error: "Expected reason" });
  }

  try {
    const task = await markTaskCannotDo({
      tableName: dynamoTable,
      siteId,
      taskId,
      reason,
      note: typeof note === "string" ? note : undefined,
    });
    return jsonResponse(200, { task });
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") {
      return jsonResponse(404, { error: "Task not found" });
    }
    if (err instanceof Error && err.name === "InvalidReason") {
      return jsonResponse(400, { error: "Invalid cannot-do reason" });
    }
    throw err;
  }
};

/**
 * POST /v1/tasks/{taskId}/complete
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const completeTask = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = event.pathParameters?.taskId;
  if (!taskId) return jsonResponse(400, { error: "Missing taskId" });

  /** @type {unknown} */
  let body = {};
  if (event.body) {
    try {
      body = readJsonBody(event);
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }
  }
  const { completionMethod } =
    /** @type {{ completionMethod?: unknown }} */ (body ?? {});

  try {
    const task = await completeTaskWithAppActions({
      tableName: dynamoTable,
      siteId,
      taskId,
      completionMethod:
        typeof completionMethod === "string" ? completionMethod : undefined,
    });
    return jsonResponse(200, { task });
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") {
      return jsonResponse(404, { error: "Task not found" });
    }
    throw err;
  }
};
