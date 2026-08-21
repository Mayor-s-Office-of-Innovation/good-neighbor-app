import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../../db.js";
import {
  assessmentKey,
  assessmentConditionPrefix,
  assessmentTimelineGsi,
  conditionKey,
  conditionTimelineGsi,
  taskKey,
  taskWorklistDateGsi,
  unresolvedConditionGsi,
} from "../../handlers/keys.js";
import { evaluateCondition } from "./evaluator.js";
import {
  executeAppActions,
  initialAppActionStatus,
  summarizeAppActionResults,
} from "./app-actions.js";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";

/**
 * @typedef {import("./rule-catalog.js").GuidanceCatalog} GuidanceCatalog
 * @typedef {import("./evaluator.js").EvaluationResult} EvaluationResult
 */

const MAX_TRANSACTION_ITEMS = 100;
const BATCH_GET_LIMIT = 100;
const TASK_COMPLETION_LEASE_MS = 5 * 60 * 1000;

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} name
 * @param {string} message
 * @returns {Error}
 */
function namedError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

/**
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
function isNeedsAnswer(item) {
  return item.status === "needs_answer";
}

/**
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
function isManualReview(item) {
  return item.status === "manual_review";
}

/**
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
function isResolvedToTasks(item) {
  return item.resolvedToTasks === true;
}

/**
 * @param {Record<string, unknown>} task
 * @returns {boolean}
 */
function isEmergencyTask(task) {
  return /** @type {{ code?: string, payload?: { phoneNumber?: unknown } }[]} */ (
    task.appActions ?? []
  ).some(
    (action) =>
      action.code === "open_phone" && action.payload?.phoneNumber === "911",
  );
}

/**
 * @param {unknown} value
 * @param {Date} now
 * @returns {boolean}
 */
function isExpiredLease(value, now) {
  return typeof value !== "string" || Date.parse(value) <= now.getTime();
}

/**
 * @param {object} opts
 * @param {Record<string, unknown>} opts.assessment
 * @param {Record<string, unknown>} opts.priorCondition
 * @param {Record<string, unknown>} opts.nextCondition
 * @param {Record<string, unknown> | null} opts.taskItem
 * @param {string} opts.now
 * @returns {Record<string, unknown>}
 */
function applyAssessmentConditionDelta({
  assessment,
  priorCondition,
  nextCondition,
  taskItem,
  now,
}) {
  const priorSummary = /** @type {Record<string, number>} */ (
    assessment.summary ?? {}
  );
  const summary = {
    totalConditions: Number(priorSummary.totalConditions ?? 0),
    conditionsNeedAnswer:
      Number(priorSummary.conditionsNeedAnswer ?? 0) +
      (isNeedsAnswer(nextCondition) ? 1 : 0) -
      (isNeedsAnswer(priorCondition) ? 1 : 0),
    conditionsResolvedToTasks:
      Number(priorSummary.conditionsResolvedToTasks ?? 0) +
      (isResolvedToTasks(nextCondition) ? 1 : 0) -
      (isResolvedToTasks(priorCondition) ? 1 : 0),
    openTaskCount: Number(priorSummary.openTaskCount ?? 0) + (taskItem ? 1 : 0),
    actionCount:
      Number(priorSummary.actionCount ?? 0) +
      (taskItem?.kind === "action" ? 1 : 0),
    escalationCount:
      Number(priorSummary.escalationCount ?? 0) +
      (taskItem?.kind === "escalation" ? 1 : 0),
    emergencyCount:
      Number(priorSummary.emergencyCount ?? 0) +
      (taskItem && isEmergencyTask(taskItem) ? 1 : 0),
    manualReviewCount:
      Number(priorSummary.manualReviewCount ?? 0) +
      (isManualReview(nextCondition) ? 1 : 0) -
      (isManualReview(priorCondition) ? 1 : 0),
  };

  const status =
    summary.manualReviewCount > 0
      ? "manual_review"
      : summary.conditionsNeedAnswer > 0
        ? "needs_answers"
        : "tasks_created";

  return {
    ...assessment,
    status,
    summary,
    assessmentRevision: Number(assessment.assessmentRevision ?? 0) + 1,
    updatedAt: now,
  };
}

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
 * @property {string[]} [disputedCategories] analyzer category names the reviewer
 *   marked "I don't see this problem". Their conditions are recorded but never
 *   turned into tasks (kept for false-positive analysis).
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
 * @param {EvaluationResult | null} opts.evaluation null when the condition was
 *   disputed (no rule evaluation runs).
 * @param {boolean} [opts.disputed] the reviewer marked this "I don't see this
 *   problem": persist the condition as a terminal record, mint no task.
 * @param {string} opts.policyVersion
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
  disputed = false,
  policyVersion,
  taskIds,
  now,
}) {
  // A disputed condition is terminal: it never mints a task and never enters the
  // needs-answer / manual-review queue, but the record is kept for analysis.
  const unresolved = !disputed && evaluation?.kind !== "outcome";
  const base = {
    ...conditionKey(siteId, assessmentId, conditionId),
    entityType: "CONDITION",
    conditionId,
    assessmentId,
    checkId,
    policyVersion,
    source: {
      artifactIds: condition.sourceArtifactIds ?? [],
      evidenceIndices: condition.evidenceIndices ?? [],
      reportedAt,
      ...condition.source,
    },
    analyzerCategory: condition.category,
    canonicalCategory: disputed
      ? condition.category
      : evaluation?.kind === "manual_review"
        ? (evaluation.category ?? condition.category)
        : (evaluation?.category ?? condition.category),
    severity: condition.severity,
    severityLabel: condition.severityLabel,
    description: condition.description,
    answers: {},
    status: disputed
      ? "disputed"
      : evaluation?.kind === "needs_answer"
        ? "needs_answer"
        : evaluation?.kind === "outcome"
          ? "tasks_created"
          : evaluation?.kind === "manual_review"
            ? "manual_review"
            : "completed",
    // Reviewer feedback kept for false-positive analysis. Only the "I don't see
    // this problem" disposition suppresses task creation (see storeEvaluatedAssessment).
    disputed,
    disputeDisposition: disputed ? "not_present" : null,
    selectedRuleId:
      evaluation?.kind === "outcome" ? evaluation.rule.ruleId : null,
    outcome: evaluation?.kind === "outcome" ? evaluation.outcome : null,
    taskIds,
    resolvedToTasks: evaluation?.kind === "outcome",
    needsAnswer:
      evaluation?.kind === "needs_answer" ? evaluation.question : null,
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
    appActionStatus: initialAppActionStatus(rule.outcome.appActions),
    appActionResults: [],
    category311: rule.outcome.category311,
    cannotDoReasons: rule.outcome.cannotDoReasons,
    sourceArtifactIds: condition.sourceArtifactIds ?? [],
    ...taskWorklistDateGsi(
      siteId,
      status,
      kind,
      condition.severity,
      now,
      taskId,
    ),
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
  const catalog = options.catalog ?? activeCatalog();
  const now = (options.now ?? new Date()).toISOString();
  const idFactory = options.idFactory ?? randomUUID;

  // Analyzer categories the reviewer marked "I don't see this problem". Their
  // conditions are still persisted (for false-positive analysis) but never
  // evaluated into tasks.
  const disputedCategories = new Set(input.disputedCategories ?? []);

  /** @type {Record<string, unknown>[]} */
  const conditionItems = [];
  /** @type {Record<string, unknown>[]} */
  const taskItems = [];

  for (const [index, condition] of input.conditions.entries()) {
    const conditionId =
      condition.conditionId ?? makeConditionId(condition.category, index);
    const disputed = disputedCategories.has(condition.category);

    // Disputed conditions skip rule evaluation and task minting entirely.
    const evaluation = disputed
      ? null
      : evaluateCondition({
          condition: {
            category: condition.category,
            severity: condition.severity,
          },
          catalog,
        });

    /** @type {string[]} */
    const taskIds = [];
    if (evaluation && evaluation.kind === "outcome") {
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
        disputed,
        policyVersion: catalog.policyVersion,
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
  const disputedCount = conditionItems.filter(
    (item) => item.disputed === true,
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
    assessmentRevision: 0,
    reportedAt: input.reportedAt,
    rawAssessment: input.rawAssessment,
    summary: {
      totalConditions: input.conditions.length,
      conditionsNeedAnswer,
      conditionsResolvedToTasks,
      disputedCount,
      openTaskCount: taskItems.length,
      actionCount,
      escalationCount,
      emergencyCount,
      manualReviewCount,
    },
    ...assessmentTimelineGsi(
      input.siteId,
      input.reportedAt,
      input.assessmentId,
    ),
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

  const transactItems = [
    put(assessmentItem),
    ...conditionItems.map(put),
    ...taskItems.map(put),
  ];
  if (transactItems.length > MAX_TRANSACTION_ITEMS) {
    throw namedError(
      "TransactionTooLarge",
      `Assessment creates ${transactItems.length} DynamoDB transaction items; maximum is ${MAX_TRANSACTION_ITEMS}`,
    );
  }

  await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));

  return { assessmentItem, conditionItems, taskItems };
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.assessmentId
 * @returns {Promise<{ assessment: Record<string, unknown> | null, conditions: Record<string, unknown>[], tasks: Record<string, unknown>[] }>}
 */
export async function getAssessmentGuidance({
  tableName,
  siteId,
  assessmentId,
}) {
  const [assessmentResult, conditionsResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: assessmentKey(siteId, assessmentId),
        ConsistentRead: true,
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": assessmentConditionPrefix(assessmentId),
        },
      }),
    ),
  ]);

  const conditions = conditionsResult.Items ?? [];
  const taskKeys = conditions.flatMap((condition) =>
    /** @type {string[]} */ (condition.taskIds ?? []).map((taskId) =>
      taskKey(siteId, taskId),
    ),
  );

  const tasks =
    taskKeys.length === 0
      ? []
      : await batchGetAll({ tableName, keys: taskKeys });

  return {
    assessment: assessmentResult.Item ?? null,
    conditions,
    tasks,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.assessmentId
 * @param {string} opts.conditionId
 * @param {Record<string, unknown>} opts.answers
 * @param {GuidanceCatalog} [opts.catalog]
 * @param {() => string} [opts.idFactory]
 * @param {Date} [opts.now]
 * @returns {Promise<{ assessmentItem: Record<string, unknown>, conditionItem: Record<string, unknown>, taskItem: Record<string, unknown> | null, evaluation: EvaluationResult }>}
 */
export async function answerCondition(opts) {
  const now = (opts.now ?? new Date()).toISOString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [assessmentResult, conditionResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: opts.tableName,
          Key: assessmentKey(opts.siteId, opts.assessmentId),
          ConsistentRead: true,
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: opts.tableName,
          Key: conditionKey(opts.siteId, opts.assessmentId, opts.conditionId),
          ConsistentRead: true,
        }),
      ),
    ]);
    if (!assessmentResult.Item) {
      throw namedError("NotFound", "Assessment not found");
    }
    if (!conditionResult.Item) {
      throw namedError("NotFound", "Condition not found");
    }

    const assessmentItem = assessmentResult.Item;
    const conditionItem = conditionResult.Item;
    if (conditionItem.status !== "needs_answer") {
      const err = namedError(
        "TransactionCanceledException",
        "Condition is not awaiting answers",
      );
      throw err;
    }

    const policyVersion = String(
      conditionItem.policyVersion ?? assessmentItem.policyVersion ?? "",
    );
    const catalog = opts.catalog ?? catalogForPolicyVersion(policyVersion);
    const mergedAnswers = {
      .../** @type {Record<string, unknown>} */ (conditionItem.answers ?? {}),
      ...opts.answers,
    };
    const evaluation = evaluateCondition({
      condition: {
        category: String(
          conditionItem.analyzerCategory ?? conditionItem.canonicalCategory,
        ),
        severity: Number(conditionItem.severity ?? 0),
      },
      answers: mergedAnswers,
      catalog,
    });

    /** @type {Record<string, unknown> | null} */
    let taskItem = null;
    /** @type {string[]} */
    let taskIds = /** @type {string[]} */ (conditionItem.taskIds ?? []);
    if (evaluation.kind === "outcome") {
      const taskId = (opts.idFactory ?? randomUUID)();
      taskIds = [...taskIds, taskId];
      taskItem = buildTaskItem({
        siteId: opts.siteId,
        assessmentId: opts.assessmentId,
        checkId:
          typeof conditionItem.checkId === "string"
            ? conditionItem.checkId
            : undefined,
        condition: {
          category: String(conditionItem.analyzerCategory),
          severity: Number(conditionItem.severity),
          sourceArtifactIds:
            /** @type {{ artifactIds?: string[] }} */ (conditionItem.source)
              ?.artifactIds ?? [],
        },
        conditionId: opts.conditionId,
        rule: evaluation.rule,
        taskId,
        now,
      });
    }

    const status =
      evaluation.kind === "outcome"
        ? "tasks_created"
        : evaluation.kind === "needs_answer"
          ? "needs_answer"
          : evaluation.kind === "manual_review"
            ? "manual_review"
            : "completed";

    const updatedCondition = {
      ...conditionItem,
      policyVersion: catalog.policyVersion,
      answers: mergedAnswers,
      status,
      selectedRuleId:
        evaluation.kind === "outcome" ? evaluation.rule.ruleId : null,
      outcome: evaluation.kind === "outcome" ? evaluation.outcome : null,
      taskIds,
      resolvedToTasks: evaluation.kind === "outcome",
      needsAnswer:
        evaluation.kind === "needs_answer" ? evaluation.question : null,
      updatedAt: now,
    };
    if (evaluation.kind === "outcome") {
      const sparseCondition = /** @type {Record<string, unknown>} */ (
        updatedCondition
      );
      delete sparseCondition.gsi5pk;
      delete sparseCondition.gsi5sk;
    }

    const priorRevision = Number(assessmentItem.assessmentRevision ?? 0);
    const updatedAssessment = applyAssessmentConditionDelta({
      assessment: assessmentItem,
      priorCondition: conditionItem,
      nextCondition: updatedCondition,
      taskItem,
      now,
    });

    /** @type {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>} */
    const tx = [
      {
        Put: {
          TableName: opts.tableName,
          Item: updatedAssessment,
          ConditionExpression:
            "attribute_exists(sk) AND (attribute_not_exists(#revision) OR #revision = :priorRevision)",
          ExpressionAttributeNames: { "#revision": "assessmentRevision" },
          ExpressionAttributeValues: { ":priorRevision": priorRevision },
        },
      },
      {
        Put: {
          TableName: opts.tableName,
          Item: updatedCondition,
          ConditionExpression: "#status = :needsAnswer",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":needsAnswer": "needs_answer" },
        },
      },
    ];

    if (taskItem) {
      tx.push({
        Put: {
          TableName: opts.tableName,
          Item: taskItem,
          ConditionExpression: "attribute_not_exists(sk)",
        },
      });
    }

    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: tx }));
      return {
        assessmentItem: updatedAssessment,
        conditionItem: updatedCondition,
        taskItem,
        evaluation,
      };
    } catch (err) {
      if (
        err instanceof Error &&
        err.name === "TransactionCanceledException" &&
        attempt < 2
      ) {
        continue;
      }
      throw err;
    }
  }

  throw namedError("TransactionCanceledException", "Condition answer conflict");
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.taskId
 * @param {string} opts.reason
 * @param {string} [opts.note]
 * @param {Date} [opts.now]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function markTaskCannotDo(opts) {
  const now = (opts.now ?? new Date()).toISOString();
  const existing = await ddb.send(
    new GetCommand({
      TableName: opts.tableName,
      Key: taskKey(opts.siteId, opts.taskId),
      ConsistentRead: true,
    }),
  );
  if (!existing.Item) {
    throw namedError("NotFound", "Task not found");
  }
  if (existing.Item.status === "cannot_do") {
    const cannotDo = /** @type {{ reason?: unknown, note?: unknown }} */ (
      existing.Item.cannotDo ?? {}
    );
    if (cannotDo.reason === opts.reason && cannotDo.note === opts.note) {
      return existing.Item;
    }
    throw namedError("TerminalConflict", "Task is already cannot_do");
  }
  if (existing.Item.status !== "open") {
    throw namedError("TerminalConflict", "Task is no longer open");
  }
  const allowed = /** @type {string[]} */ (existing.Item.cannotDoReasons ?? []);
  if (allowed.length > 0 && !allowed.includes(opts.reason)) {
    throw namedError("InvalidReason", "Invalid cannot-do reason");
  }

  const updated = {
    ...existing.Item,
    status: "cannot_do",
    cannotDo: { reason: opts.reason, note: opts.note, recordedAt: now },
    updatedAt: now,
    ...taskWorklistDateGsi(
      opts.siteId,
      "cannot_do",
      String(existing.Item.kind),
      Number(existing.Item.severity ?? 0),
      now,
      opts.taskId,
    ),
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: opts.tableName,
            Item: updated,
            ConditionExpression: "#status = :open",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":open": "open" },
          },
        },
      ],
    }),
  );
  return updated;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.taskId
 * @param {string} [opts.completionMethod]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {Date} [opts.now]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function completeTaskWithAppActions(opts) {
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(
    nowDate.getTime() + TASK_COMPLETION_LEASE_MS,
  ).toISOString();
  const existing = await ddb.send(
    new GetCommand({
      TableName: opts.tableName,
      Key: taskKey(opts.siteId, opts.taskId),
      ConsistentRead: true,
    }),
  );
  if (!existing.Item) {
    throw namedError("NotFound", "Task not found");
  }
  if (existing.Item.status === "completed") {
    const method = opts.completionMethod ?? "user_confirmed";
    if (existing.Item.completionMethod === method) {
      return existing.Item;
    }
    throw namedError("TerminalConflict", "Task is already completed");
  }
  if (
    existing.Item.status === "completing" &&
    !isExpiredLease(existing.Item.completionLeaseExpiresAt, nowDate)
  ) {
    throw namedError("TaskCompletionInProgress", "Task completion in progress");
  }
  if (
    existing.Item.status !== "open" &&
    existing.Item.status !== "completing"
  ) {
    throw namedError("TerminalConflict", "Task is no longer open");
  }

  let claimCondition = "#status = :open";
  /** @type {Record<string, string>} */
  let claimExpressionAttributeNames = { "#status": "status" };
  /** @type {Record<string, string>} */
  let claimExpressionAttributeValues = { ":open": "open" };
  if (existing.Item.status === "completing") {
    claimCondition =
      "#status = :completing AND (attribute_not_exists(#lease) OR #lease <= :now)";
    claimExpressionAttributeNames = {
      "#status": "status",
      "#lease": "completionLeaseExpiresAt",
    };
    claimExpressionAttributeValues = {
      ":completing": "completing",
      ":now": now,
    };
  }
  const claimed = {
    ...existing.Item,
    status: "completing",
    appActionStatus: "executing",
    completionStartedAt:
      typeof existing.Item.completionStartedAt === "string"
        ? existing.Item.completionStartedAt
        : now,
    completionLeaseExpiresAt: leaseExpiresAt,
    updatedAt: now,
    ...taskWorklistDateGsi(
      opts.siteId,
      "completing",
      String(existing.Item.kind),
      Number(existing.Item.severity ?? 0),
      now,
      opts.taskId,
    ),
  };
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: opts.tableName,
            Item: claimed,
            ConditionExpression: claimCondition,
            ExpressionAttributeNames: claimExpressionAttributeNames,
            ExpressionAttributeValues: claimExpressionAttributeValues,
          },
        },
      ],
    }),
  );

  const appActions = /** @type {import("./app-actions.js").AppAction[]} */ (
    existing.Item.appActions ?? []
  );
  const appActionResults = executeAppActions(appActions, {
    env: opts.env,
    now: nowDate,
    taskId: opts.taskId,
  });

  const updated = {
    ...claimed,
    status: "completed",
    completedAt: now,
    completionMethod: opts.completionMethod ?? "user_confirmed",
    appActionStatus: summarizeAppActionResults(appActionResults),
    appActionResults,
    updatedAt: now,
    ...taskWorklistDateGsi(
      opts.siteId,
      "completed",
      String(existing.Item.kind),
      Number(existing.Item.severity ?? 0),
      now,
      opts.taskId,
    ),
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: opts.tableName,
            Item: updated,
            ConditionExpression:
              "#status = :completing AND #lease = :leaseExpiresAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#lease": "completionLeaseExpiresAt",
            },
            ExpressionAttributeValues: {
              ":completing": "completing",
              ":leaseExpiresAt": leaseExpiresAt,
            },
          },
        },
      ],
    }),
  );
  return updated;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {Record<string, string>[]} opts.keys
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function batchGetAll({ tableName, keys }) {
  /** @type {Record<string, unknown>[]} */
  const items = [];

  for (let start = 0; start < keys.length; start += BATCH_GET_LIMIT) {
    let requestKeys = keys.slice(start, start + BATCH_GET_LIMIT);
    for (let attempt = 0; requestKeys.length > 0; attempt += 1) {
      const result = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: { Keys: requestKeys, ConsistentRead: true },
          },
        }),
      );
      items.push(...(result.Responses?.[tableName] ?? []));
      requestKeys =
        /** @type {{ [key: string]: { Keys?: Record<string, string>[] } } | undefined} */ (
          result.UnprocessedKeys
        )?.[tableName]?.Keys ?? [];
      if (requestKeys.length > 0) {
        if (attempt >= 5) {
          throw namedError(
            "BatchGetIncomplete",
            "DynamoDB left task keys unprocessed",
          );
        }
        await sleep(25 * 2 ** attempt);
      }
    }
  }

  return items;
}
