import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../../db.js";
import {
  assessmentKey,
  assessmentTimelineGsi,
  conditionKey,
  conditionTimelineGsi,
  taskKey,
  taskWorklistDateGsi,
  unresolvedConditionGsi,
} from "../../handlers/keys.js";
import { evaluateCondition } from "./evaluator.js";
import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";

/**
 * @typedef {import("./rule-catalog.js").GuidanceCatalog} GuidanceCatalog
 * @typedef {import("./evaluator.js").EvaluationResult} EvaluationResult
 */

/**
 * @typedef {object} AssessmentConditionInput
 * @property {string} [conditionId]
 * @property {string} category
 * @property {number} severity
 * @property {string} [severityLabel]
 * @property {string} [description]
 * @property {string[]} [sourceArtifactIds]
 * @property {number[]} [evidenceIndices]
 * @property {Record<string, unknown>} [source]
 */

/**
 * @typedef {object} StoreAssessmentInput
 * @property {string} siteId
 * @property {string} assessmentId
 * @property {string} [checkId]
 * @property {string} reportedAt
 * @property {string} [rubricVersion]
 * @property {string | null} [grade]
 * @property {Record<string, unknown>} rawAssessment
 * @property {AssessmentConditionInput[]} conditions
 */

/**
 * @typedef {object} StoreAssessmentOptions
 * @property {string} tableName
 * @property {GuidanceCatalog} [catalog]
 * @property {() => string} [idFactory]
 * @property {Date} [now]
 */

/**
 * @param {string} category
 * @param {number} index
 * @returns {string}
 */
export function makeConditionId(category, index) {
  return `${String(index + 1).padStart(3, "0")}-${category
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/**
 * @param {object} opts
 * @param {string} opts.siteId
 * @param {string} opts.assessmentId
 * @param {AssessmentConditionInput} opts.condition
 * @param {string} opts.conditionId
 * @param {string | undefined} opts.checkId
 * @param {string} opts.reportedAt
 * @param {EvaluationResult} opts.evaluation
 * @param {string[]} opts.taskIds
 * @param {string} opts.now
 * @returns {Record<string, unknown>}
 */
function buildConditionItem({
  siteId,
  assessmentId,
  condition,
  conditionId,
  checkId,
  reportedAt,
  evaluation,
  taskIds,
  now,
}) {
  const unresolved = evaluation.kind !== "outcome";
  const base = {
    ...conditionKey(siteId, assessmentId, conditionId),
    entityType: "CONDITION",
    conditionId,
    assessmentId,
    checkId,
    source: {
      artifactIds: condition.sourceArtifactIds ?? [],
      evidenceIndices: condition.evidenceIndices ?? [],
      reportedAt,
      ...condition.source,
    },
    analyzerCategory: condition.category,
    canonicalCategory:
      evaluation.kind === "manual_review"
        ? (evaluation.category ?? condition.category)
        : evaluation.category,
    severity: condition.severity,
    severityLabel: condition.severityLabel,
    description: condition.description,
    answers: {},
    status:
      evaluation.kind === "needs_answer"
        ? "needs_answer"
        : evaluation.kind === "outcome"
          ? "tasks_created"
          : evaluation.kind === "manual_review"
            ? "manual_review"
            : "completed",
    selectedRuleId: evaluation.kind === "outcome" ? evaluation.rule.ruleId : null,
    outcome: evaluation.kind === "outcome" ? evaluation.outcome : null,
    taskIds,
    resolvedToTasks: evaluation.kind === "outcome",
    needsAnswer: evaluation.kind === "needs_answer" ? evaluation.question : null,
    cannotDo: null,
    ...conditionTimelineGsi(
      siteId,
      condition.severity,
      reportedAt,
      assessmentId,
      conditionId,
    ),
    createdAt: now,
    updatedAt: now,
  };

  return unresolved
    ? {
        ...base,
        ...unresolvedConditionGsi(
          siteId,
          condition.severity,
          reportedAt,
          assessmentId,
          conditionId,
        ),
      }
    : base;
}

/**
 * @param {object} opts
 * @param {string} opts.siteId
 * @param {string} opts.assessmentId
 * @param {string | undefined} opts.checkId
 * @param {AssessmentConditionInput} opts.condition
 * @param {string} opts.conditionId
 * @param {import("./rule-catalog.js").GuidanceRule} opts.rule
 * @param {string} opts.taskId
 * @param {string} opts.now
 * @returns {Record<string, unknown>}
 */
function buildTaskItem({
  siteId,
  assessmentId,
  checkId,
  condition,
  conditionId,
  rule,
  taskId,
  now,
}) {
  const status = "open";
  const kind = rule.outcome.kind;
  return {
    ...taskKey(siteId, taskId),
    entityType: "TASK",
    taskId,
    assessmentId,
    checkId,
    conditionId,
    policyVersion: rule.policyVersion,
    ruleId: rule.ruleId,
    kind,
    type: kind === "action" ? "onsite" : "city_escalation",
    status,
    category: rule.category,
    analyzerCategory: condition.category,
    severity: condition.severity,
    label: rule.outcome.label,
    guidance: rule.outcome.guidance,
    buttons: rule.outcome.buttons,
    appActions: rule.outcome.appActions,
    category311: rule.outcome.category311,
    cannotDoReasons: rule.outcome.cannotDoReasons,
    sourceArtifactIds: condition.sourceArtifactIds ?? [],
    ...taskWorklistDateGsi(siteId, status, kind, condition.severity, now, taskId),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Store one assessment report, condition items, and immediately resolvable task
 * items in one transaction.
 * @param {StoreAssessmentInput} input
 * @param {StoreAssessmentOptions} options
 * @returns {Promise<{ assessmentItem: Record<string, unknown>, conditionItems: Record<string, unknown>[], taskItems: Record<string, unknown>[] }>}
 */
export async function storeEvaluatedAssessment(input, options) {
  const catalog = options.catalog ?? actionsEscalationsV2Catalog;
  const now = (options.now ?? new Date()).toISOString();
  const idFactory = options.idFactory ?? randomUUID;

  /** @type {Record<string, unknown>[]} */
  const conditionItems = [];
  /** @type {Record<string, unknown>[]} */
  const taskItems = [];

  for (const [index, condition] of input.conditions.entries()) {
    const conditionId = condition.conditionId ?? makeConditionId(condition.category, index);
    const evaluation = evaluateCondition({
      condition: { category: condition.category, severity: condition.severity },
      catalog,
    });

    /** @type {string[]} */
    const taskIds = [];
    if (evaluation.kind === "outcome") {
      const taskId = idFactory();
      taskIds.push(taskId);
      taskItems.push(
        buildTaskItem({
          siteId: input.siteId,
          assessmentId: input.assessmentId,
          checkId: input.checkId,
          condition,
          conditionId,
          rule: evaluation.rule,
          taskId,
          now,
        }),
      );
    }

    conditionItems.push(
      buildConditionItem({
        siteId: input.siteId,
        assessmentId: input.assessmentId,
        condition,
        conditionId,
        checkId: input.checkId,
        reportedAt: input.reportedAt,
        evaluation,
        taskIds,
        now,
      }),
    );
  }

  const conditionsNeedAnswer = conditionItems.filter(
    (item) => item.status === "needs_answer",
  ).length;
  const manualReviewCount = conditionItems.filter(
    (item) => item.status === "manual_review",
  ).length;
  const conditionsResolvedToTasks = conditionItems.filter(
    (item) => item.resolvedToTasks,
  ).length;
  const actionCount = taskItems.filter((item) => item.kind === "action").length;
  const escalationCount = taskItems.filter(
    (item) => item.kind === "escalation",
  ).length;
  const emergencyCount = taskItems.filter((item) =>
    /** @type {{ code?: string, payload?: { phoneNumber?: unknown } }[]} */ (
      item.appActions
    ).some(
      (action) =>
        action.code === "open_phone" && action.payload?.phoneNumber === "911",
    ),
  ).length;

  const assessmentStatus =
    manualReviewCount > 0
      ? "manual_review"
      : conditionsNeedAnswer > 0
        ? "needs_answers"
        : "tasks_created";

  const assessmentItem = {
    ...assessmentKey(input.siteId, input.assessmentId),
    entityType: "ASSESSMENT",
    assessmentId: input.assessmentId,
    checkId: input.checkId,
    status: assessmentStatus,
    policyVersion: catalog.policyVersion,
    rubricVersion: input.rubricVersion,
    grade: input.grade,
    reportedAt: input.reportedAt,
    rawAssessment: input.rawAssessment,
    summary: {
      totalConditions: input.conditions.length,
      conditionsNeedAnswer,
      conditionsResolvedToTasks,
      openTaskCount: taskItems.length,
      actionCount,
      escalationCount,
      emergencyCount,
      manualReviewCount,
    },
    ...assessmentTimelineGsi(input.siteId, input.reportedAt, input.assessmentId),
    createdAt: now,
    updatedAt: now,
  };

  /**
   * @param {Record<string, unknown>} Item
   * @returns {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>[number]}
   */
  const put = (Item) => ({
    Put: {
      TableName: options.tableName,
      Item,
      ConditionExpression: "attribute_not_exists(sk)",
    },
  });

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        put(assessmentItem),
        ...conditionItems.map(put),
        ...taskItems.map(put),
      ],
    }),
  );

  return { assessmentItem, conditionItems, taskItems };
}
