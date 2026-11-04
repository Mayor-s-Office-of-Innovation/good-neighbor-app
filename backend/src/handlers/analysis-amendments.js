import { categoryOptions, actionOptions } from "./task-details.js";
import { catalogForPolicyVersion } from "../analysis/guidance/catalog-registry.js";
import { answerCondition } from "../analysis/guidance/guidance-store.js";
import { assessmentKey, conditionKey } from "./keys.js";
import { deleteTaskGroup } from "../analysis/duplicates/deletion.js";
import { statusConditionId } from "../domain/system-status.js";
import {
  descriptionWrites,
  taskDescriptionWrite,
  validDescription,
  validTitle,
} from "./description-edits.js";
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { getConfig } from "../config.js";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import {
  ANALYZER_TIMEOUT_CODE,
  AnalyzerError,
  createAnalyzerClient,
} from "../analysis/analyzer-client.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { supersedeOpenTasksForCondition } from "../analysis/guidance/guidance-store.js";
import { analysisKey } from "./keys.js";

const APP_ID = "good-neighbor-app";

/** Max description length forwarded to the analyzer (matches artifact text). */
const MAX_DESCRIPTION_LENGTH = 4000;
/** Max reject-reason note length forwarded to the analyzer. */
const MAX_NOTE_LENGTH = 1000;

// The analyzer wait on the request path is bounded: a hung analyzer must not
// hold an api execution for the function's full 29 s. One attempt may use the
// whole 8 s, and a timed-out attempt is never replayed (the analyzer may still
// commit it; its amendment endpoints are not idempotent). Fast failures with a
// known outcome retry inside the same 8 s. The analysis worker keeps its own,
// longer budget.
const ANALYZER_WAIT_MS = 8_000;

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
    requestTimeoutMs: ANALYZER_WAIT_MS,
    totalBudgetMs: ANALYZER_WAIT_MS,
  });
}

/**
 * @param {unknown} err
 * @returns {import("aws-lambda").APIGatewayProxyResult}
 */
function errorResponse(err) {
  if (err instanceof Error && "statusCode" in err && err.statusCode === 409)
    return jsonResponse(409, {
      error: err.message,
      code: "code" in err ? err.code : "group_changed",
    });
  if (err instanceof AnalyzerError && err.code === ANALYZER_TIMEOUT_CODE) {
    // We stopped waiting; the analyzer may or may not have committed the
    // amendment. Verified rejections handle this with a durable local
    // dismissal below; edits and unverified rejections remain unconfirmed.
    return jsonResponse(504, {
      error:
        "The analyzer did not answer in time; whether the change was saved is not known",
      code: ANALYZER_TIMEOUT_CODE,
    });
  }
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
 * @returns {Promise<{ analysisId: string, checkId: string, artifactId: string, concerns: any[] } | null>}
 *   Null when the artifact has no ANALYSIS# item (not yet analyzed) or the item
 *   is a failed marker (no analysisId) — callers map null to 404.
 */
async function findAnalysisContext({ tableName, siteId, checkId, artifactId }) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: analysisKey(siteId, checkId, artifactId),
      ConsistentRead: true,
      ProjectionExpression: "checkId, artifactId, analysisId, concerns",
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
    concerns: item.concerns || [],
    analysisId: item.analysisId,
    checkId: item.checkId,
    artifactId: item.artifactId,
  };
}

/** @param {any} event */
async function conditionContext(event) {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const { checkId, artifactId, conditionId } = event.pathParameters || {};
  const read = async (/** @type {{pk:string,sk:string}} */ Key) =>
    (
      await ddb.send(
        new GetCommand({ TableName: dynamoTable, Key, ConsistentRead: true }),
      )
    ).Item;
  const requestedId = event.queryStringParameters?.assessmentId;
  if (requestedId) {
    const assessment = await read(assessmentKey(siteId, requestedId));
    const condition = await read(
      conditionKey(siteId, requestedId, conditionId),
    );
    if (
      !assessment ||
      assessment.checkId !== checkId ||
      assessment.supersededByAssessmentId ||
      !condition ||
      !condition.source?.artifactIds?.includes(artifactId)
    )
      return null;
    return { condition, assessment, assessmentId: requestedId };
  }
  const pointer = await read({
    pk: `SITE#${siteId}`,
    sk: `GUIDANCE_CURRENT#${JSON.stringify([checkId, artifactId])}`,
  });
  if (!pointer?.assessmentId) return null;
  const condition = await read(
    conditionKey(siteId, pointer.assessmentId, conditionId),
  );
  const assessment = await read(assessmentKey(siteId, pointer.assessmentId));
  return condition && assessment && !assessment.supersededByAssessmentId
    ? { condition, assessment, assessmentId: pointer.assessmentId }
    : null;
}

/** GET the current generated condition and its selectable actions. @param {any} event */
export async function getAnalysisConditionDetails(event) {
  const context = await conditionContext(event);
  if (!context) return jsonResponse(404, { error: "Condition not found" });
  const { condition, assessment } = context;
  const selection = {
    policyVersion: condition.policyVersion || assessment.policyVersion,
    category: condition.canonicalCategory || condition.category,
    ruleId: condition.selectedRuleId,
  };
  return jsonResponse(200, {
    clicked: condition,
    members: [{ ...condition, checkId: assessment.checkId }],
    category: selection.category,
    editable:
      condition.status === "needs_answer" ||
      condition.status === "manual_review",
    categories: categoryOptions(selection),
    actions: actionOptions(selection).options,
    selectedRuleId: "",
    revision: Number(assessment.assessmentRevision || 0),
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
  const bodyObject =
    body && typeof body === "object"
      ? /** @type {{ description?: unknown, language?: unknown, title?: string, category?: string, ruleId?: string, customAction?: {text:string,resolved:boolean}, revision?: number, requestId?: string }} */ (
          body
        )
      : undefined;
  if (
    bodyObject?.requestId !== undefined &&
    (typeof bodyObject.requestId !== "string" ||
      bodyObject.requestId.length > 100)
  )
    return jsonResponse(400, { error: "Invalid requestId" });
  if (
    bodyObject?.ruleId &&
    (!Number.isSafeInteger(bodyObject.revision) ||
      Number(bodyObject.revision) < 0)
  )
    return jsonResponse(400, {
      error: "A valid revision is required for action edits",
    });
  const description = bodyObject?.description;
  if (bodyObject?.title !== undefined && !validTitle(bodyObject.title))
    return jsonResponse(400, { error: "Invalid title" });
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
  if (!validDescription(description))
    return jsonResponse(400, { error: "Invalid description" });
  try {
    if (
      bodyObject?.ruleId ||
      bodyObject?.category ||
      bodyObject?.title !== undefined
    ) {
      const context = await conditionContext(event);
      if (!context) return jsonResponse(404, { error: "Condition not found" });
      if (
        bodyObject.revision !== undefined &&
        bodyObject.revision !==
          Number(context.assessment.assessmentRevision || 0) &&
        context.condition.detailsEditId !== bodyObject.requestId
      )
        return jsonResponse(409, { error: "Issue changed while editing" });
      if (
        !bodyObject.ruleId &&
        bodyObject.requestId &&
        context.condition.detailsEditId === bodyObject.requestId
      )
        return jsonResponse(200, {
          description: context.condition.description,
          condition: context.condition,
          assessment: context.assessment,
        });
      if (bodyObject.ruleId) {
        const catalog = catalogForPolicyVersion(
          context.condition.policyVersion || context.assessment.policyVersion,
        );
        const category =
          bodyObject.category || context.condition.canonicalCategory;
        const custom = bodyObject.ruleId === "__custom__";
        const rule = catalog.rules.find(
          (candidate) =>
            candidate.category === category &&
            candidate.outcome.buttons[0] &&
            (custom || candidate.ruleId === bodyObject.ruleId),
        );
        if (
          !rule ||
          (custom &&
            (!bodyObject.customAction?.text?.trim() ||
              bodyObject.customAction.text.length > 1000 ||
              typeof bodyObject.customAction.resolved !== "boolean"))
        )
          return jsonResponse(400, { error: "Invalid action" });
        const result = await answerCondition({
          tableName: dynamoTable,
          siteId,
          assessmentId: context.assessmentId,
          conditionId,
          answers: {},
          manualEdit: {
            ...bodyObject,
            description: description.trim(),
            ruleId: rule.ruleId,
            customAction: custom ? bodyObject.customAction : undefined,
          },
        });
        return jsonResponse(200, {
          description: description.trim(),
          condition: result.conditionItem,
          task: result.taskItem,
          assessment: result.assessmentItem,
        });
      }
      if (
        bodyObject.category &&
        bodyObject.category !== context.condition.canonicalCategory
      )
        return jsonResponse(400, {
          error: "Select an action for the category",
        });
    }
    const edit = await descriptionWrites({
      table: dynamoTable,
      siteId,
      checkId,
      artifactId,
      conditionId,
      description,
      title: bodyObject?.title,
      assessmentId: event.queryStringParameters?.assessmentId,
      revision: bodyObject?.revision,
      requestId: bodyObject?.requestId,
    });
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...edit.writes,
          ...edit.tasks.map((task) =>
            taskDescriptionWrite(
              dynamoTable,
              task,
              description,
              bodyObject?.title,
            ),
          ),
        ],
      }),
    );
    return jsonResponse(200, {
      description: description.trim(),
      condition: edit.condition,
    });
  } catch (error) {
    if (error instanceof Error && "status" in error)
      return jsonResponse(Number(error.status), { error: error.message });
    if (
      error instanceof Error &&
      [
        "TransactionCanceledException",
        "AssessmentRevisionConflict",
        "ConditionDismissed",
      ].includes(error.name)
    )
      return jsonResponse(409, { error: "Description changed while editing" });
    throw error;
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
  const input =
    /** @type {{ reason?: { key?: unknown, note?: unknown }, taskId?: unknown, deletionTaskIds?: string[], deletionMode?: "selected" }} */ (
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
    if (typeof input.taskId === "string" && input.taskId) {
      if (
        input.deletionTaskIds !== undefined &&
        (!Array.isArray(input.deletionTaskIds) ||
          !input.deletionTaskIds.every((id) => typeof id === "string"))
      )
        return jsonResponse(400, { error: "Invalid deletion scope" });
      if (input.deletionMode !== undefined && input.deletionMode !== "selected")
        return jsonResponse(400, { error: "Invalid deletion mode" });
      const deleted = await deleteTaskGroup(dynamoTable, siteId, {
        taskId: input.taskId,
        checkId,
        artifactId,
        conditionId,
        expectedTaskIds: input.deletionTaskIds,
        mode: input.deletionMode,
      });
      return jsonResponse(200, { deleted });
    }
    const context = await findAnalysisContext({
      tableName: dynamoTable,
      siteId,
      checkId,
      artifactId,
    });
    if (!context) {
      return jsonResponse(404, { error: "Analysis not found" });
    }
    const key = {
      pk: `SITE#${siteId}`,
      sk: `ISSUE_DELETION#${context.checkId}:${context.artifactId}:${conditionId}`,
    };
    const knownConcern = context.concerns.find(
      (/** @type {any} */ c, /** @type {number} */ index) =>
        statusConditionId(context.artifactId, c, index) === conditionId,
    );
    let receipt = (
      await ddb.send(
        new GetCommand({
          TableName: dynamoTable,
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (!receipt) {
      // Persist identity and attempt time before the external, non-transactional call.
      receipt = {
        ...key,
        state: "pending",
        attemptedAt: new Date().toISOString(),
        category: knownConcern?.category || "unknown",
      };
      try {
        await ddb.send(
          new PutCommand({
            TableName: dynamoTable,
            Item: receipt,
            ConditionExpression: "attribute_not_exists(sk)",
          }),
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
        receipt = (
          await ddb.send(
            new GetCommand({
              TableName: dynamoTable,
              Key: key,
              ConsistentRead: true,
            }),
          )
        ).Item;
        if (!receipt)
          throw new Error("Missing rejection attempt after concurrent write");
      }
    }
    let result = receipt.result || {
      analysis_id: context.analysisId,
      rejected_condition_id: conditionId,
      already_rejected: true,
    };
    if (!receipt.deletedAt && !receipt.dismissedAt) {
      const client = await analyzerClient();
      let accepted = false;
      let dismissed = false;
      let dismissalReason = "analysis_unavailable";
      try {
        result = await client.rejectCondition(context.analysisId, conditionId, {
          ...(reason ? { reason } : {}),
          appId: APP_ID,
          requestId: requestId(
            body,
            `${context.analysisId}#${conditionId}#reject`,
          ),
        });
        accepted = true;
      } catch (err) {
        if (
          err instanceof AnalyzerError &&
          (err.code === ANALYZER_TIMEOUT_CODE ||
            (err.status === 404 &&
              (err.code === "unknown_analysis" ||
                err.code === "unknown_condition"))) &&
          knownConcern
        ) {
          // The site-owned stored analysis verifies this condition. Dismiss it
          // locally without claiming the analyzer accepted a rejection.
          dismissed = true;
          dismissalReason =
            err.code === ANALYZER_TIMEOUT_CODE
              ? "analyzer_timeout"
              : err.code === "unknown_condition"
                ? "condition_unavailable"
                : "analysis_unavailable";
          result = {
            analysis_id: context.analysisId,
            condition_id: conditionId,
            dismissed_locally: true,
          };
        } else if (
          !(err instanceof AnalyzerError) ||
          err.status !== 404 ||
          err.code !== "unknown_condition"
        ) {
          throw err;
        }
        // Absence upstream does not confirm a durable app dismissal.
        if (!accepted && !dismissed)
          return jsonResponse(409, {
            code: "RejectionUnconfirmed",
            error: "Deletion is not confirmed; retry",
          });
      }
      if (accepted || dismissed) {
        const upstreamTime = result?.rejection?.created_at;
        const deletedAt =
          typeof upstreamTime === "string" &&
          Number.isFinite(Date.parse(upstreamTime))
            ? new Date(upstreamTime).toISOString()
            : new Date().toISOString();
        // Confirm before cleanup. A later cleanup failure reuses this durable
        // receipt and timestamp without calling the analyzer again.
        const confirmation = new PutCommand({
          TableName: dynamoTable,
          Item: {
            ...receipt,
            state: dismissed ? "dismissed" : "confirmed",
            ...(dismissed
              ? {
                  dismissedAt: new Date().toISOString(),
                  dismissalReason,
                }
              : { deletedAt }),
            category: knownConcern?.category || receipt.category,
            result: dismissed
              ? result
              : {
                  analysis_id: context.analysisId,
                  rejected_condition_id: conditionId,
                  already_rejected: true,
                },
          },
          ConditionExpression:
            "attribute_not_exists(deletedAt) AND attribute_not_exists(dismissedAt)",
        });
        // Keep the accepted timestamp in memory across transient persistence
        // failures; never repeat the upstream rejection to retry this write.
        for (let attempt = 0; ; attempt++) {
          try {
            await ddb.send(confirmation);
            break;
          } catch (error) {
            if (
              error instanceof Error &&
              error.name === "ConditionalCheckFailedException"
            )
              break;
            if (attempt >= 2) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, 50 * 2 ** attempt),
            );
          }
        }
      }
    }
    // Cleanup is safe after acceptance or an already-missing condition. Only
    // a confirmed receipt above contributes to deletion reporting.
    await supersedeOpenTasksForCondition({
      tableName: dynamoTable,
      siteId,
      checkId: context.checkId,
      conditionId,
      assessmentIdPrefix: `${context.checkId}-${context.artifactId}`,
      analysisId: context.analysisId,
      ...(typeof input.taskId === "string" && input.taskId
        ? { taskId: input.taskId }
        : {}),
      reason: "analysis_condition_rejected",
    });
    return jsonResponse(200, { ...result, deleted: [] });
  } catch (err) {
    return errorResponse(err);
  }
}
