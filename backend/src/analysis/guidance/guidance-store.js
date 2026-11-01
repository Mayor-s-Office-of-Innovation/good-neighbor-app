import {
  evidenceDeletionKey,
  evidencePublicationGuards,
  evidenceIds,
  retractableTask,
} from "./evidence-deletion.js";
import { deliberate311Decision } from "../../domain/deliberate-311.js";
import { sf311Job } from "./sf311-job.js";
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../../db.js";
import {
  assessmentKey,
  assessmentConditionPrefix,
  assessmentTimelineGsi,
  conditionKey,
  GSI2_NAME,
  siteMetaKey,
  taskDisplayCounterKey,
  taskKey,
  taskTimelineGsi,
  taskTimelineGsiFor,
  taskUpdateKey,
  taskUpdatePointerKey,
  taskUpdateTimelineGsi,
  taskWorklistPk,
  taskWorklistDateGsi,
} from "../../handlers/keys.js";
import { evaluateCondition } from "./evaluator.js";
import {
  executeAppActions,
  initialAppActionStatus,
  is311AsyncFilingEnabled,
  is311SubmissionEnabled,
  summarizeAppActionResults,
  mergeAppActionResults,
} from "./app-actions.js";
import { queue311Filing } from "./sf311-filing-queue.js";
import { activeCatalog, catalogForPolicyVersion } from "./catalog-registry.js";
import { logServerError } from "../../lib/log-server-error.js";
import { shortCodePart } from "../../lib/short-codes.js";
import {
  mergeTranslations,
  normalizeTranslations,
  translationsEqual,
} from "../translations.js";

/**
 * `translations` attribute for a new CONDITION#/TASK# item: the per-locale map,
 * or nothing. Normalizing here (not only in the evaluate handler) keeps the
 * storage shape uniform whatever the caller passed.
 * @param {unknown} value
 * @returns {{ translations?: import("../translations.js").TranslationsMap }}
 */
function translationsField(value) {
  const translations = normalizeTranslations(value);
  return translations ? { translations } : {};
}

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
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @returns {Promise<{ providerShortCode: string, siteShortCode: string }>}
 */
async function getTaskShortCodeParts({ tableName, siteId }) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: siteMetaKey(siteId),
      ConsistentRead: true,
    }),
  );
  const site = result.Item ?? {};
  return {
    providerShortCode: shortCodePart(
      site.providerShortCode,
      String(site.providerId ?? siteId),
    ),
    siteShortCode: shortCodePart(
      site.siteShortCode,
      String(site.name ?? siteId),
    ),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {number} opts.count
 * @returns {Promise<string[]>}
 */
async function allocateTaskShortIds({ tableName, siteId, count }) {
  if (count <= 0) return [];
  const [codes, counter] = await Promise.all([
    getTaskShortCodeParts({ tableName, siteId }),
    ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: taskDisplayCounterKey(siteId),
        UpdateExpression:
          "SET entityType = if_not_exists(entityType, :entityType), #type = if_not_exists(#type, :type), siteId = if_not_exists(siteId, :siteId) ADD nextTaskDisplayNumber :count",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: {
          ":entityType": "COUNTER",
          ":type": "task-display-id-counter",
          ":siteId": siteId,
          ":count": count,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    ),
  ]);
  const end = Number(counter.Attributes?.nextTaskDisplayNumber ?? 0);
  const start = end - count + 1;
  return Array.from({ length: count }, (_, index) => {
    const nnn = String(start + index).padStart(3, "0");
    return `${codes.providerShortCode}-${codes.siteShortCode}-${nnn}`;
  });
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
  return [
    task.label,
    task.guidance,
    .../** @type {unknown[]} */ (task.buttons ?? []),
  ].some((value) => /\b911\b/.test(String(value ?? "")));
}

/**
 * @param {Record<string, unknown>} task
 * @returns {boolean}
 */
function hasUserConfirmed311Action(task) {
  return /** @type {{ code?: unknown, payload?: { executionTrigger?: unknown } }[]} */ (
    task.appActions ?? []
  ).some(
    (action) =>
      action.code === "create_311_ticket" &&
      action.payload?.executionTrigger !== "task_created",
  );
}

/**
 * @param {import("./app-actions.js").AppActionResult[]} results
 * @returns {boolean}
 */
function hasSubmitted311ActionResult(results) {
  return results.some(
    (result) =>
      result.code === "create_311_ticket" && result.status === "submitted",
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
      (taskItem?.kind === "escalation" ||
      taskItem?.kind === "non_actionable_escalation"
        ? 1
        : 0),
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
 * Per-locale copies of `userFriendlyLabel` / `description` (the normalized
 * map from analysis/translations.js; the evaluate handler converts the
 * analyzer's single block before it reaches here).
 * @typedef {import("../translations.js").TranslationsMap} ConditionTranslationsInput
 */

/**
 * @typedef {object} AssessmentConditionInput
 * @property {string} [conditionId]
 * @property {string} category
 * @property {number} severity
 * @property {string} [severityLabel]
 * @property {string} [userFriendlyLabel]
 * @property {string} [description]
 * @property {ConditionTranslationsInput} [translations]
 * @property {string[]} [sourceArtifactIds]
 * @property {number[]} [evidenceIndices]
 * @property {Record<string, unknown>} [source]
 */

/**
 * @typedef {object} StoreAssessmentInput
 * @property {string} siteId
 * @property {string} assessmentId
 * @property {string} [previousAssessmentId]
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
 * @property {Record<string, string | undefined>} [env]
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
 * @param {EvaluationResult} opts.evaluation the rule evaluation for this condition.
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
  policyVersion,
  taskIds,
  now,
}) {
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
    canonicalCategory:
      evaluation.kind === "manual_review"
        ? (evaluation.category ?? condition.category)
        : (evaluation.category ?? condition.category),
    severity: condition.severity,
    severityLabel: condition.severityLabel,
    userFriendlyLabel: condition.userFriendlyLabel,
    description: condition.description,
    ...translationsField(condition.translations),
    answers: {},
    status:
      evaluation.kind === "needs_answer"
        ? "needs_answer"
        : evaluation.kind === "outcome"
          ? "tasks_created"
          : evaluation.kind === "manual_review"
            ? "manual_review"
            : "completed",
    selectedRuleId:
      evaluation.kind === "outcome" ? evaluation.rule.ruleId : null,
    outcome: evaluation.kind === "outcome" ? evaluation.outcome : null,
    taskIds,
    resolvedToTasks: evaluation.kind === "outcome",
    needsAnswer:
      evaluation.kind === "needs_answer" ? evaluation.question : null,
    createdAt: now,
    updatedAt: now,
  };

  return base;
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
 * @param {string} opts.shortId
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
  shortId,
  now,
}) {
  const status = "open";
  const kind = rule.outcome.kind;
  return {
    ...taskKey(siteId, taskId),
    entityType: "TASK",
    taskId,
    shortId,
    assessmentId,
    checkId,
    conditionId,
    policyVersion: rule.policyVersion,
    canBeInProgress: rule.canBeInProgress,
    primaryInProgressAgency: rule.primaryInProgressAgency,
    ...(rule.maxAcceptableResponseHours === undefined
      ? {}
      : { maxAcceptableResponseHours: rule.maxAcceptableResponseHours }),
    ruleId: rule.ruleId,
    kind,
    type: kind === "action" ? "onsite" : "city_escalation",
    status,
    category: rule.category,
    analyzerCategory: condition.category,
    severity: condition.severity,
    userFriendlyLabel: condition.userFriendlyLabel,
    label: rule.outcome.label,
    description: condition.description,
    ...translationsField(condition.translations),
    guidance: rule.outcome.guidance,
    buttons: rule.outcome.buttons,
    appActions: rule.outcome.appActions,
    appActionStatus: initialAppActionStatus(rule.outcome.appActions),
    appActionResults: [],
    category311: rule.outcome.category311,
    phoneNumber: rule.outcome.phoneNumber || "",
    sourceArtifactIds: condition.sourceArtifactIds ?? [],
    source: condition.source ?? {},
    ...taskWorklistDateGsi(
      siteId,
      status,
      kind,
      condition.severity,
      now,
      taskId,
    ),
    ...taskTimelineGsi(siteId, now, taskId),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @param {string} siteId
 * @param {string} checkId
 * @param {string} lineageId
 * @returns {{pk: string, sk: string}}
 */
function currentAssessmentKey(siteId, checkId, lineageId) {
  return {
    pk: `SITE#${siteId}`,
    sk: `GUIDANCE_CURRENT#${JSON.stringify([checkId, lineageId])}`,
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
  let catalog = options.catalog ?? activeCatalog();
  const now = (options.now ?? new Date()).toISOString();
  const idFactory = options.idFactory ?? randomUUID;

  // Read persisted answers, never accept client-supplied task/answer snapshots.
  const previous = input.previousAssessmentId
    ? await getAssessmentGuidance({
        tableName: options.tableName,
        siteId: input.siteId,
        assessmentId: input.previousAssessmentId,
      })
    : null;
  if (!options.catalog && previous?.assessment?.policyVersion) {
    catalog = catalogForPolicyVersion(
      String(previous.assessment.policyVersion),
    );
  }
  if (
    previous &&
    (!previous.assessment ||
      !input.checkId ||
      previous.assessment.checkId !== input.checkId)
  ) {
    throw namedError(
      "InvalidAssessmentRevision",
      "Previous assessment must belong to the same check",
    );
  }
  if (previous?.assessment?.supersededByAssessmentId) {
    throw namedError(
      "AssessmentRevisionConflict",
      "Assessment has been replaced",
    );
  }
  // Refreshes are revisions of the original report, not new observations.
  // Keep time-dependent rubric evaluation pinned to the first assessment's
  // reported time even if the analyzer sends a newer timestamp on refresh.
  const previousReportedAt = previous?.assessment?.reportedAt;
  const reportedAt =
    typeof previousReportedAt === "string" &&
    Number.isFinite(Date.parse(previousReportedAt))
      ? previousReportedAt
      : input.reportedAt;
  const artifactId =
    typeof input.rawAssessment.artifactId === "string"
      ? input.rawAssessment.artifactId
      : undefined;
  const priorArtifactId =
    previous?.assessment?.rawAssessment &&
    /** @type {Record<string, unknown>} */ (previous.assessment.rawAssessment)
      .artifactId;
  if (previous && artifactId !== priorArtifactId) {
    throw namedError(
      "InvalidAssessmentRevision",
      "Previous assessment must belong to the same artifact",
    );
  }
  // Artifact-less API assessments use their original assessment as the lineage.
  // Never infer identity from a category/index-generated condition ID alone.
  const lineageId = String(
    previous?.assessment?.lineageId ??
      priorArtifactId ??
      artifactId ??
      input.previousAssessmentId ??
      input.assessmentId,
  );
  const retainedConditionIds = new Set();
  /** @type {Record<string, unknown>[]} */
  const retainedTasks = [];
  /** @type {{ taskId: string, translations: ConditionTranslationsInput | undefined }[]} */
  const retainedTaskTranslationUpdates = [];

  /** @type {Record<string, unknown>[]} */
  const conditionItems = [];
  /** @type {Parameters<typeof buildTaskItem>[0][]} */
  const pendingTaskInputs = [];

  for (const [index, condition] of input.conditions.entries()) {
    const conditionId =
      condition.conditionId ?? makeConditionId(condition.category, index);
    const prior = previous?.conditions.find((item) => {
      const source = /** @type {{ artifactIds?: string[] }} */ (
        item.source ?? {}
      );
      return (
        item.conditionId === conditionId &&
        item.policyVersion === catalog.policyVersion &&
        item.analyzerCategory === condition.category &&
        item.severity === condition.severity &&
        (item.userFriendlyLabel ?? "") ===
          (condition.userFriendlyLabel ?? "") &&
        (item.description ?? "") === (condition.description ?? "") &&
        (Boolean(condition.sourceArtifactIds?.length) ||
          Boolean(condition.conditionId && item.explicitConditionId)) &&
        JSON.stringify([...(source.artifactIds ?? [])].sort()) ===
          JSON.stringify([...(condition.sourceArtifactIds ?? [])].sort())
      );
    });
    const priorTaskIds = /** @type {string[]} */ (prior?.taskIds ?? []);
    const priorTasks =
      previous?.tasks.filter((task) =>
        priorTaskIds.includes(String(task.taskId)),
      ) ?? [];
    if (
      prior &&
      priorTasks.length === priorTaskIds.length &&
      priorTasks.every((task) => task.status !== "superseded")
    ) {
      // A retained condition has the same English text as before, so every
      // stored locale is still valid: merge per locale, letting a refresh that
      // carries a locale replace that locale and keeping the rest (the
      // background translate worker may have filled them in since). A refresh
      // without any keeps the prior map.
      const translations = mergeTranslations(
        prior.translations,
        condition.translations,
      );
      const preserved = {
        ...prior,
        ...(translations ? { translations } : {}),
        ...conditionKey(input.siteId, input.assessmentId, conditionId),
        assessmentId: input.assessmentId,
      };
      retainedConditionIds.add(conditionId);
      conditionItems.push(preserved);
      for (const task of priorTasks) {
        if (translationsEqual(task.translations, translations)) {
          retainedTasks.push(task);
          continue;
        }
        const updatedTranslations = { ...task };
        if (translations) updatedTranslations.translations = translations;
        else delete updatedTranslations.translations;
        retainedTasks.push(updatedTranslations);
        retainedTaskTranslationUpdates.push({
          taskId: String(task.taskId),
          translations,
        });
      }
      continue;
    }
    const evaluation = evaluateCondition({
      condition: {
        category: condition.category,
        severity: condition.severity,
      },
      catalog,
      reportedAt,
    });

    /** @type {string[]} */
    const taskIds = [];
    if (evaluation.kind === "outcome") {
      const taskId = idFactory();
      taskIds.push(taskId);
      pendingTaskInputs.push({
        siteId: input.siteId,
        assessmentId: input.assessmentId,
        checkId: input.checkId,
        condition,
        conditionId,
        rule: evaluation.rule,
        taskId,
        shortId: "",
        now,
      });
    }

    conditionItems.push(
      buildConditionItem({
        siteId: input.siteId,
        assessmentId: input.assessmentId,
        condition,
        conditionId,
        checkId: input.checkId,
        reportedAt,
        evaluation,
        policyVersion: catalog.policyVersion,
        taskIds,
        now,
      }),
    );
  }

  for (const [index, item] of conditionItems.entries()) {
    item.explicitConditionId = Boolean(input.conditions[index].conditionId);
  }
  const retiredIds = new Set(
    (previous?.conditions ?? [])
      .filter((condition) => !retainedConditionIds.has(condition.conditionId))
      .flatMap(
        (condition) => /** @type {string[]} */ (condition.taskIds ?? []),
      ),
  );
  const retiredTasks = (previous?.tasks ?? []).filter((task) =>
    retiredIds.has(String(task.taskId)),
  );
  // A completing task may already have external effects. Reconcile after it
  // settles instead of replacing it or undoing its in-flight transition.
  if (retiredTasks.some((task) => task.status === "completing")) {
    throw namedError(
      "TaskTransitionConflict",
      "A task is currently completing",
    );
  }
  const evidenceGuards = input.checkId
    ? evidencePublicationGuards(
        options.tableName,
        input.siteId,
        input.checkId,
        [
          ...(artifactId ? [artifactId] : []),
          ...input.conditions.flatMap(
            (condition) => condition.sourceArtifactIds || [],
          ),
        ],
      )
    : [];
  const jobCount = pendingTaskInputs.reduce(
    (count, taskInput) =>
      count +
      sf311Job(
        options.tableName,
        input.siteId,
        { appActions: taskInput.rule.outcome.appActions },
        "created",
        options.env,
      ).length,
    0,
  );
  const publicationSize =
    1 +
    Number(Boolean(input.checkId)) +
    Number(Boolean(previous)) +
    evidenceGuards.length +
    conditionItems.length +
    pendingTaskInputs.length +
    jobCount +
    retiredTasks.filter((task) => task.status === "open").length +
    retainedTaskTranslationUpdates.length;
  if (publicationSize > MAX_TRANSACTION_ITEMS) {
    throw namedError(
      "TransactionTooLarge",
      `Assessment creates ${publicationSize} DynamoDB transaction items; maximum is ${MAX_TRANSACTION_ITEMS}`,
    );
  }
  const shortIds = await allocateTaskShortIds({
    tableName: options.tableName,
    siteId: input.siteId,
    count: pendingTaskInputs.length,
  });
  const newTaskItems = pendingTaskInputs.map((taskInput, index) =>
    buildTaskItem({ ...taskInput, shortId: shortIds[index] }),
  );
  const taskItems = [...retainedTasks, ...newTaskItems];

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
    (item) =>
      item.kind === "escalation" || item.kind === "non_actionable_escalation",
  ).length;
  const emergencyCount = taskItems.filter((item) =>
    isEmergencyTask(item),
  ).length;

  // "tasks_created" must mean tasks were actually minted. An assessment whose
  // conditions produced no rule outcome creates zero tasks, so it reports
  // "no_tasks" rather than contradicting an openTaskCount:0 summary.
  const assessmentStatus =
    manualReviewCount > 0
      ? "manual_review"
      : conditionsNeedAnswer > 0
        ? "needs_answers"
        : taskItems.length > 0
          ? "tasks_created"
          : "no_tasks";

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
    lineageId,
    reportedAt,
    rawAssessment: input.rawAssessment,
    summary: {
      totalConditions: input.conditions.length,
      conditionsNeedAnswer,
      conditionsResolvedToTasks,
      openTaskCount: taskItems.filter(
        (task) => task.status === "open" || task.status === "completing",
      ).length,
      actionCount,
      escalationCount,
      emergencyCount,
      manualReviewCount,
    },
    ...assessmentTimelineGsi(input.siteId, reportedAt, input.assessmentId),
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
    ...evidenceGuards,
    put(assessmentItem),
    ...conditionItems.map(put),
    ...newTaskItems.map(put),
  ];
  // Publish the pointer and successor together. The predecessor marker also
  // closes the race with answers and safely adopts pre-pointer assessments.
  if (input.checkId) {
    transactItems.push({
      Put: {
        TableName: options.tableName,
        Item: {
          ...currentAssessmentKey(input.siteId, input.checkId, lineageId),
          entityType: "GUIDANCE_CURRENT",
          assessmentId: input.assessmentId,
        },
        ConditionExpression: previous
          ? "attribute_not_exists(sk) OR assessmentId = :previous"
          : "attribute_not_exists(sk)",
        ...(previous
          ? {
              ExpressionAttributeValues: {
                ":previous": input.previousAssessmentId,
              },
            }
          : {}),
      },
    });
  }
  if (previous?.assessment) {
    transactItems.push({
      Update: {
        TableName: options.tableName,
        Key: assessmentKey(input.siteId, String(input.previousAssessmentId)),
        UpdateExpression:
          "SET supersededByAssessmentId = :next, lineageId = :lineage",
        ConditionExpression:
          "attribute_not_exists(supersededByAssessmentId) AND (assessmentRevision = :revision OR attribute_not_exists(assessmentRevision))",
        ExpressionAttributeValues: {
          ":next": input.assessmentId,
          ":lineage": lineageId,
          ":revision": previous.assessment.assessmentRevision ?? 0,
        },
      },
    });
  }
  for (const task of retiredTasks.filter((task) => task.status === "open")) {
    transactItems.push({
      Put: {
        TableName: options.tableName,
        Item: {
          ...task,
          ...taskTimelineGsiFor(input.siteId, task),
          status: "superseded",
          supersededAt: now,
          supersessionReason: "assessment_refreshed",
          updatedAt: now,
          ...taskWorklistDateGsi(
            input.siteId,
            "superseded",
            String(task.kind),
            Number(task.severity ?? 0),
            now,
            String(task.taskId),
          ),
        },
        ConditionExpression:
          "#status = :open AND " +
          (task.updatedAt
            ? "updatedAt = :updatedAt"
            : "attribute_not_exists(updatedAt)"),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":open": "open",
          ...(task.updatedAt ? { ":updatedAt": task.updatedAt } : {}),
        },
      },
    });
  }
  // Keep a retained task's translations map in step with its retained
  // condition (per-locale merge); only tasks that actually differ get an Update.
  for (const { taskId, translations } of retainedTaskTranslationUpdates) {
    transactItems.push({
      Update: {
        TableName: options.tableName,
        Key: taskKey(input.siteId, taskId),
        ...(translations
          ? {
              UpdateExpression: "SET translations = :translations",
              ExpressionAttributeValues: { ":translations": translations },
            }
          : {
              UpdateExpression: "REMOVE translations",
            }),
      },
    });
  }
  for (const task of newTaskItems) {
    transactItems.push(
      ...sf311Job(
        options.tableName,
        input.siteId,
        task,
        "created",
        options.env,
      ),
    );
  }
  if (transactItems.length > MAX_TRANSACTION_ITEMS) {
    throw namedError(
      "TransactionTooLarge",
      `Assessment creates ${transactItems.length} DynamoDB transaction items; maximum is ${MAX_TRANSACTION_ITEMS}`,
    );
  }

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    // Only conditional conflicts are safe to reconcile; capacity/validation
    // failures must not masquerade as an answer race.
    if (
      previous &&
      err instanceof Error &&
      err.name === "TransactionCanceledException" &&
      /** @type {{ CancellationReasons?: {Code?: string}[] }} */ (
        err
      ).CancellationReasons?.some(
        (reason) => reason.Code === "ConditionalCheckFailed",
      )
    ) {
      throw namedError(
        "AssessmentRevisionConflict",
        "Assessment changed during refresh",
      );
    }
    throw err;
  }

  return {
    assessmentItem,
    conditionItems,
    taskItems: [...retainedTasks, ...newTaskItems],
  };
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
  // Read the revision before the conditions. Parallel reads can pair a newer
  // revision with older answers, defeating the publication revision check.
  const assessmentResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: assessmentKey(siteId, assessmentId),
      ConsistentRead: true,
    }),
  );
  const conditionsResult = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": assessmentConditionPrefix(assessmentId),
      },
    }),
  );

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
 * Resolve historical URLs/idempotent retries to the current published guidance.
 * @param {{tableName: string, siteId: string, assessmentId: string}} opts
 * @returns {ReturnType<typeof getAssessmentGuidance>}
 */
export async function getPublishedAssessmentGuidance(opts) {
  let result = await getAssessmentGuidance(opts);
  for (
    let attempt = 0;
    result.assessment?.supersededByAssessmentId;
    attempt += 1
  ) {
    if (attempt >= 3)
      throw namedError(
        "AssessmentRevisionConflict",
        "Guidance is changing; retry its read",
      );
    const assessment = result.assessment;
    const pointer = await ddb.send(
      new GetCommand({
        TableName: opts.tableName,
        Key: currentAssessmentKey(
          opts.siteId,
          String(assessment.checkId),
          String(assessment.lineageId),
        ),
        ConsistentRead: true,
      }),
    );
    result = await getAssessmentGuidance({
      ...opts,
      assessmentId: String(
        pointer.Item?.assessmentId ?? assessment.supersededByAssessmentId,
      ),
    });
  }
  return result;
}

/**
 * @param {Record<string, unknown>} task
 * @param {string} artifactId
 */
function isFromArtifact(task, artifactId) {
  // The guidance API can write tasks that name no photo; they used to get the fix.
  const ids = /** @type {string[]} */ (task.sourceArtifactIds ?? []);
  return ids.length === 0 || ids.includes(artifactId);
}

/**
 * Transaction items that copy a photo's late location to its tasks not yet sent
 * to 311.
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.checkId
 * @param {string} opts.artifactId
 * @param {{ latitude: number, longitude: number, accuracyMeters?: number }} opts.location
 * @param {(tasks: { taskId: string, state: "queued" | "submitted" }[]) => void} [opts.onFiled] gets the tasks already queued or filed for 311
 * @returns {Promise<NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>>}
 */
export async function artifactTaskLocationUpdates({
  tableName,
  siteId,
  checkId,
  artifactId,
  location,
  onFiled,
}) {
  const pointer = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: currentAssessmentKey(siteId, checkId, artifactId),
      ConsistentRead: true,
    }),
  );
  if (typeof pointer.Item?.assessmentId !== "string") return [];
  const { tasks } = await getAssessmentGuidance({
    tableName,
    siteId,
    assessmentId: pointer.Item.assessmentId,
  });
  const hasAccuracy = location.accuracyMeters !== undefined;
  /** @param {Record<string, unknown>} task */
  const submitted = (task) =>
    hasSubmitted311ActionResult(
      /** @type {import("./app-actions.js").AppActionResult[]} */ (
        task.appActionResults ?? []
      ),
    );
  /** @param {Record<string, unknown>} task */
  const filed = (task) =>
    task.inProgressActionKind === "311_filed" || submitted(task);
  // One assessment can hold tasks from other photos via the API.
  const own = tasks.filter((task) => isFromArtifact(task, artifactId));
  onFiled?.(
    own.filter(filed).map((task) => ({
      taskId: String(task.taskId),
      state: submitted(task) ? "submitted" : "queued",
    })),
  );
  return own
    .filter(
      (task) =>
        ["open", "in_progress"].includes(String(task.status)) && !filed(task),
    )
    .map((task) => ({
      Update: {
        TableName: tableName,
        Key: taskKey(siteId, String(task.taskId)),
        // Bumping updatedAt makes a writer holding an older copy fail its check.
        UpdateExpression: `SET #source.#lat = :lat, #source.#lng = :lng${
          hasAccuracy ? ", #source.#acc = :acc" : ""
        }, updatedAt = :now`,
        // A filing that started after the read above keeps its location.
        ConditionExpression:
          "attribute_exists(#source) AND #status IN (:open, :inProgress) AND " +
          "(attribute_not_exists(inProgressActionKind) OR inProgressActionKind <> :filed) AND " +
          (task.updatedAt
            ? "updatedAt = :updatedAt"
            : "attribute_not_exists(updatedAt)") +
          (hasAccuracy
            ? " AND (attribute_not_exists(#source.#lat) OR attribute_not_exists(#source.#acc) OR #source.#acc > :acc)"
            : " AND attribute_not_exists(#source.#lat)"),
        ExpressionAttributeNames: {
          "#source": "source",
          "#status": "status",
          "#lat": "latitude",
          "#lng": "longitude",
          ...(hasAccuracy ? { "#acc": "accuracyMeters" } : {}),
        },
        ExpressionAttributeValues: {
          ":lat": location.latitude,
          ":lng": location.longitude,
          ...(hasAccuracy ? { ":acc": location.accuracyMeters } : {}),
          ":open": "open",
          ":inProgress": "in_progress",
          ":filed": "311_filed",
          ...(task.updatedAt ? { ":updatedAt": task.updatedAt } : {}),
          ":now": new Date().toISOString(),
        },
      },
    }));
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
 * @param {Record<string, string | undefined>} [opts.env]
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
    if (assessmentItem.supersededByAssessmentId) {
      throw namedError(
        "AssessmentRevisionConflict",
        "Assessment has been replaced; reload its guidance",
      );
    }
    if (conditionItem.status !== "needs_answer") {
      const err = namedError(
        "TransactionCanceledException",
        "Condition is not awaiting answers",
      );
      throw err;
    }

    // Keep the condition's original source identity for dismissal receipts,
    // but only publish tasks from evidence that still exists.
    const checkId = String(
      conditionItem.checkId || assessmentItem.checkId || "",
    );
    const originalEvidence = evidenceIds(conditionItem);
    const survivingEvidence = [];
    for (const artifactId of originalEvidence) {
      const removed = checkId
        ? await ddb.send(
            new GetCommand({
              TableName: opts.tableName,
              Key: evidenceDeletionKey(opts.siteId, checkId, artifactId),
              ConsistentRead: true,
            }),
          )
        : { Item: undefined };
      if (!removed.Item) survivingEvidence.push(artifactId);
    }
    if (originalEvidence.length && !survivingEvidence.length)
      throw namedError(
        "ConditionDismissed",
        "Supporting evidence has been deleted",
      );

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
      reportedAt: String(
        /** @type {Record<string, unknown>} */ (conditionItem.source ?? {})
          .reportedAt ?? "",
      ),
    });

    /** @type {Record<string, unknown> | null} */
    let taskItem = null;
    /** @type {string[]} */
    let taskIds = /** @type {string[]} */ (conditionItem.taskIds ?? []);
    if (evaluation.kind === "outcome") {
      const taskId = (opts.idFactory ?? randomUUID)();
      const [shortId] = await allocateTaskShortIds({
        tableName: opts.tableName,
        siteId: opts.siteId,
        count: 1,
      });
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
          userFriendlyLabel:
            typeof conditionItem.userFriendlyLabel === "string"
              ? conditionItem.userFriendlyLabel
              : undefined,
          description:
            typeof conditionItem.description === "string"
              ? conditionItem.description
              : undefined,
          ...(conditionItem.translations
            ? { translations: conditionItem.translations }
            : {}),
          sourceArtifactIds: survivingEvidence,
          source: {
            ...(conditionItem.source && typeof conditionItem.source === "object"
              ? /** @type {Record<string, unknown>} */ (conditionItem.source)
              : {}),
          },
        },
        conditionId: opts.conditionId,
        rule: evaluation.rule,
        taskId,
        shortId,
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
            "attribute_exists(sk) AND attribute_not_exists(supersededByAssessmentId) AND (attribute_not_exists(#revision) OR #revision = :priorRevision)",
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

    if (taskItem)
      tx.push(
        ...sf311Job(opts.tableName, opts.siteId, taskItem, "created", opts.env),
      );
    if (conditionItem.checkId || assessmentItem.checkId)
      tx.push(
        ...evidencePublicationGuards(
          opts.tableName,
          opts.siteId,
          String(conditionItem.checkId || assessmentItem.checkId),
          survivingEvidence,
        ),
      );
    const deletionKey = conditionDeletionKey(
      opts.siteId,
      assessmentItem,
      conditionItem,
    );
    if (deletionKey)
      tx.push({
        ConditionCheck: {
          TableName: opts.tableName,
          Key: deletionKey,
          ConditionExpression:
            "attribute_not_exists(deletedAt) AND attribute_not_exists(dismissedAt)",
        },
      });
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: tx }));
      return {
        assessmentItem: updatedAssessment,
        conditionItem: updatedCondition,
        taskItem,
        evaluation,
      };
    } catch (err) {
      const reasons = /** @type {{CancellationReasons?: {Code?: string}[]}} */ (
        err
      )?.CancellationReasons;
      if (
        deletionKey &&
        reasons?.[tx.length - 1]?.Code === "ConditionalCheckFailed"
      )
        throw namedError(
          "ConditionDismissed",
          "Condition has been dismissed; reload its guidance",
        );
      if (err instanceof Error && err.name === "TransactionCanceledException") {
        // Re-evaluate surviving sources on retry, including when DynamoDB
        // omits cancellation reasons. Never classify unrelated conflicts as deletion.
        if (attempt < 2) continue;
        if (checkId && originalEvidence.length) {
          const removed = await Promise.all(
            originalEvidence.map(
              async (id) =>
                (
                  await ddb.send(
                    new GetCommand({
                      TableName: opts.tableName,
                      Key: evidenceDeletionKey(opts.siteId, checkId, id),
                      ConsistentRead: true,
                    }),
                  )
                ).Item,
            ),
          );
          if (removed.every(Boolean))
            throw namedError(
              "ConditionDismissed",
              "Supporting evidence has been deleted",
            );
        }
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
 * @param {string} [opts.completionMethod]
 * @param {string} [opts.actorId]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {any[]} [opts.duplicateChecks]
 * @param {Date} [opts.now]
 * @param {boolean} [opts.forceComplete]
 * @param {boolean} [opts.skipUserConfirmedActions]
 * @param {Record<string, unknown>} [opts.taskPatch]
 * @param {string} [opts.timelineType]
 * @param {string} [opts.timelineLabel]
 * @param {string} [opts.timelineText]
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
  if (
    existing.Item.status === "completed" ||
    (existing.Item.status === "in_progress" &&
      existing.Item.kind === "non_actionable_escalation")
  ) {
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
  const filingDecision =
    opts.skipUserConfirmedActions !== true &&
    hasUserConfirmed311Action(existing.Item) &&
    is311SubmissionEnabled(opts.env ?? process.env)
      ? await deliberate311Decision(
          opts.tableName,
          opts.siteId,
          existing.Item,
          now,
        )
      : undefined;
  if (
    opts.completionMethod === "311_filed" &&
    is311AsyncFilingEnabled(opts.env ?? process.env) &&
    is311SubmissionEnabled(opts.env ?? process.env)
  ) {
    if (!hasUserConfirmed311Action(existing.Item)) {
      throw namedError(
        "InvalidCompletionMethod",
        "Task has no executable 311 filing action",
      );
    }
    return queue311Filing({
      tableName: opts.tableName,
      siteId: opts.siteId,
      taskId: opts.taskId,
      task: existing.Item,
      filingDecision,
      actorId: opts.actorId,
      duplicateChecks: opts.duplicateChecks,
      now: nowDate,
    });
  }
  if (
    existing.Item.status !== "open" &&
    existing.Item.status !== "completing"
  ) {
    throw namedError("TerminalConflict", "Task is no longer open");
  }
  if (
    opts.completionMethod === "311_filed" &&
    !hasUserConfirmed311Action(existing.Item)
  ) {
    throw namedError(
      "InvalidCompletionMethod",
      "Task has no executable 311 filing action",
    );
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
    ...(filingDecision
      ? {
          deliberate311DeliveryMode: filingDecision.mode,
          deliberate311AcceptedAt: filingDecision.acceptedAt,
        }
      : {}),
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
        ...(opts.duplicateChecks ?? []),
        ...(filingDecision?.checks ?? []),
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
    opts.skipUserConfirmedActions ? [] : (existing.Item.appActions ?? [])
  );
  const priorResults =
    /** @type {import("./app-actions.js").AppActionResult[]} */ (
      existing.Item.appActionResults ?? []
    );
  const executedAppActionResults = await executeAppActions(appActions, {
    env: opts.env,
    now: nowDate,
    taskId: opts.taskId,
    tableName: opts.tableName,
    siteId: opts.siteId,
    task: claimed,
    priorResults,
    trigger: "user_confirmed",
  });
  const canBeInProgress =
    opts.forceComplete === true
      ? false
      : existing.Item.canBeInProgress === true;

  // Silent City notifications and their closure run on the durable background queue.
  const appActionResults = executedAppActionResults.reduce(
    (results, result) => mergeAppActionResults(results, result),
    [...priorResults],
  );
  const appActionStatus = summarizeAppActionResults(appActionResults);
  // Whether THIS completion attempt failed — judged only on the actions it ran
  // for this trigger, NOT on the merged history. A completion for a trigger with
  // no actions to run (e.g. a manual onsite pickup whose only app action is a
  // task_created 311 notification for the City's awareness) must not be blocked
  // by a prior/background app-action failure. A user_confirmed action that runs
  // and fails still holds the task open (`executedAppActionResults` carries it).
  const appActionFailed =
    summarizeAppActionResults(executedAppActionResults) === "failed" ||
    (opts.completionMethod === "311_filed" &&
      !hasSubmitted311ActionResult(executedAppActionResults));
  const filed311 = !appActionFailed && opts.completionMethod === "311_filed";
  const actionUpdateId = !appActionFailed ? randomUUID() : "";
  const actionLabel =
    opts.timelineLabel ??
    (filed311
      ? "311 ticket filed"
      : canBeInProgress
        ? String(existing.Item.buttons?.[0] ?? "Action taken")
        : "Site marked as resolved");
  // App-action failures hold the task open but resolve as a 200 — without this
  // line the failure exists only in the task's stored appActionResults. One
  // structured ERROR per failed action (Logs Insights-groupable, alarmable;
  // see lib/log-server-error.js for the convention).
  if (appActionFailed) {
    for (const result of executedAppActionResults) {
      if (result.status !== "failed") continue;
      logServerError(
        `task app-action ${result.code}`,
        new Error(String(result.reason ?? "app action failed")),
        {
          extra: {
            ...(["create_311_ticket", "close_311_ticket"].includes(result.code)
              ? { eventType: "311_app_action_failed", integration: "sf311" }
              : {}),
            taskId: opts.taskId,
            siteId: opts.siteId,
            ruleId: String(existing.Item.ruleId ?? ""),
            trigger: "user_confirmed",
            completionMethod: opts.completionMethod ?? "user_confirmed",
          },
        },
      );
    }
  }

  const updated = {
    ...claimed,
    ...(opts.taskPatch ?? {}),
    status: appActionFailed
      ? "open"
      : canBeInProgress
        ? "in_progress"
        : "completed",
    ...(appActionFailed || canBeInProgress
      ? {}
      : { completedAt: now, resolvedAt: now, proofAddedAt: null }),
    ...(appActionFailed || canBeInProgress
      ? {}
      : { completionMethod: opts.completionMethod ?? "user_confirmed" }),
    ...(!appActionFailed && canBeInProgress
      ? {
          inProgressAt: now,
          notifiedAt: now,
          agency: String(existing.Item.primaryInProgressAgency ?? "unknown"),
          inProgressActionKind: opts.completionMethod ?? "user_confirmed",
          latestUpdateId: actionUpdateId,
          latestUpdateLabel: actionLabel,
          lastAnsweredPresencePeriod: 0,
        }
      : {}),
    ...(!appActionFailed && existing.Item.canBeInProgress === false
      ? { latestUpdateId: actionUpdateId }
      : {}),
    appActionStatus,
    appActionResults,
    ...(filed311
      ? {
          agency: "311",
          notifiedAt: now,
          latestUpdateId: actionUpdateId,
          latestUpdateLabel: "311 ticket filed",
        }
      : {}),
    completionLeaseExpiresAt: null,
    updatedAt: now,
    ...taskWorklistDateGsi(
      opts.siteId,
      appActionFailed ? "open" : canBeInProgress ? "in_progress" : "completed",
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
        ...(updated.status === "completed" &&
        updated.completionMethod !== "311_filed" &&
        actionUpdateId
          ? sf311Job(
              opts.tableName,
              opts.siteId,
              updated,
              `resolved-${actionUpdateId}`,
              opts.env,
            )
          : []),
        ...(actionUpdateId
          ? [
              {
                Put: {
                  TableName: opts.tableName,
                  Item: {
                    ...taskUpdateKey(
                      opts.siteId,
                      opts.taskId,
                      now,
                      actionUpdateId,
                    ),
                    ...taskUpdateTimelineGsi(opts.siteId, now, actionUpdateId),
                    entityType: "task_update",
                    taskId: opts.taskId,
                    updateId: actionUpdateId,
                    type:
                      opts.timelineType ??
                      (filed311
                        ? "311_ticket_filed"
                        : canBeInProgress
                          ? "escalation_action_taken"
                          : "task_completed"),
                    label: actionLabel,
                    ...(opts.timelineText ? { text: opts.timelineText } : {}),
                    occurredAt: now,
                    actorId: opts.actorId ?? "site-team",
                    documentationState:
                      existing.Item.canBeInProgress === false
                        ? "open_for_documentation"
                        : "closed",
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Put: {
                  TableName: opts.tableName,
                  Item: {
                    ...taskUpdatePointerKey(
                      opts.siteId,
                      opts.taskId,
                      actionUpdateId,
                    ),
                    entityType: "task_update_pointer",
                    taskId: opts.taskId,
                    updateId: actionUpdateId,
                    updateSk: taskUpdateKey(
                      opts.siteId,
                      opts.taskId,
                      now,
                      actionUpdateId,
                    ).sk,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ]
          : []),
      ],
    }),
  );
  return updated;
}

/**
 * Mark open tasks for one amended analyzer condition as superseded. This is used
 * when an analysis amendment replaces/rejects a specific condition; sibling
 * condition tasks from the same assessment remain open.
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.conditionId
 * @param {string} [opts.checkId]
 * @param {string} [opts.assessmentIdPrefix]
 * @param {string} [opts.analysisId]
 * @param {string} [opts.taskId] A task ID supplied by a current task card.
 * @param {string} [opts.reason]
 * @param {Date} [opts.now]
 * @returns {Promise<{ supersededTaskIds: string[] }>}
 */
export async function supersedeOpenTasksForCondition(opts) {
  const now = (opts.now ?? new Date()).toISOString();
  const taskIds = opts.taskId ? await taskIdsForCurrentCondition(opts) : null;
  const matches = taskIds
    ? await batchGetAll({
        tableName: opts.tableName,
        keys: taskIds.map((taskId) => taskKey(opts.siteId, taskId)),
      })
    : await findOpenConditionTasks(opts);

  const tasks = matches.filter((task) => {
    if (task.status !== "open") return false;
    if (opts.checkId && task.checkId !== opts.checkId) return false;
    if (
      opts.assessmentIdPrefix &&
      !String(task.assessmentId ?? "").startsWith(opts.assessmentIdPrefix)
    ) {
      return false;
    }
    return true;
  });

  /** @type {string[]} */
  const supersededTaskIds = tasks
    .map((task) => task.taskId)
    .filter((taskId) => typeof taskId === "string" && taskId)
    .map((taskId) => String(taskId));

  for (let start = 0; start < tasks.length; start += MAX_TRANSACTION_ITEMS) {
    let pending = tasks.slice(start, start + MAX_TRANSACTION_ITEMS);
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: supersedeTaskWrites(pending, opts, now),
          }),
        );
        break;
      } catch (err) {
        if (!isSupersessionConflict(err)) throw err;

        // The analyzer has already accepted the amendment. A task transitioned
        // by another request is therefore a successful retirement outcome, not
        // a reason to report this deletion as failed. Re-read strongly and only
        // retry tasks that are still open.
        const current = await batchGetAll({
          tableName: opts.tableName,
          keys: pending.map((task) =>
            taskKey(opts.siteId, String(task.taskId)),
          ),
        });
        pending = current.filter((task) => task.status === "open");
        if (pending.length === 0) break;
        if (attempt >= 2) throw err;
      }
    }
  }

  return { supersededTaskIds };
}

/**
 * @param {Record<string, unknown>[]} tasks
 * @param {Parameters<typeof supersedeOpenTasksForCondition>[0]} opts
 * @param {string} now
 * @returns {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>}
 */
function supersedeTaskWrites(tasks, opts, now) {
  return tasks.map((task) => {
    const taskId = String(task.taskId);
    const updated = {
      ...task,
      ...taskTimelineGsiFor(opts.siteId, task),
      status: "superseded",
      supersededAt: now,
      supersessionReason: opts.reason ?? "analysis_condition_amended",
      ...(opts.analysisId ? { supersededByAnalysisId: opts.analysisId } : {}),
      updatedAt: now,
      ...taskWorklistDateGsi(
        opts.siteId,
        "superseded",
        String(task.kind),
        Number(task.severity ?? 0),
        now,
        taskId,
      ),
    };
    return {
      Put: {
        TableName: opts.tableName,
        Item: updated,
        ConditionExpression: "#status = :open",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":open": "open" },
      },
    };
  });
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isSupersessionConflict(err) {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") {
    return false;
  }
  const reasons = /** @type {{ CancellationReasons?: { Code?: string }[] }} */ (
    err
  ).CancellationReasons;
  return Boolean(
    reasons?.some(
      (reason) =>
        reason.Code === "ConditionalCheckFailed" ||
        reason.Code === "TransactionConflict",
    ),
  );
}

/**
 * Resolve task IDs from strongly consistent primary-key records. A current card
 * carries its task ID, which leads to the owning condition record and its full
 * taskIds list without relying on eventual GSI propagation.
 * @param {Parameters<typeof supersedeOpenTasksForCondition>[0]} opts
 * @returns {Promise<string[] | null>} Null preserves the legacy GSI fallback.
 */
async function taskIdsForCurrentCondition(opts) {
  const taskResult = await ddb.send(
    new GetCommand({
      TableName: opts.tableName,
      Key: taskKey(opts.siteId, String(opts.taskId)),
      ConsistentRead: true,
    }),
  );
  const task = taskResult.Item;
  if (
    !task ||
    task.conditionId !== opts.conditionId ||
    (opts.checkId && task.checkId !== opts.checkId) ||
    typeof task.assessmentId !== "string" ||
    !task.assessmentId
  ) {
    return null;
  }

  const conditionResult = await ddb.send(
    new GetCommand({
      TableName: opts.tableName,
      Key: conditionKey(opts.siteId, task.assessmentId, opts.conditionId),
      ConsistentRead: true,
    }),
  );
  const condition = conditionResult.Item;
  if (
    condition?.conditionId !== opts.conditionId ||
    (opts.checkId && condition.checkId !== opts.checkId)
  ) {
    // The task itself was strongly read and is still the safest known work to
    // retire if a legacy condition record has been removed or is malformed.
    return [String(opts.taskId)];
  }

  const conditionTaskIds = Array.isArray(condition.taskIds)
    ? condition.taskIds.filter((taskId) => typeof taskId === "string" && taskId)
    : [];
  return [...new Set([String(opts.taskId), ...conditionTaskIds])];
}

/**
 * Legacy recovery path for cards without a task ID. GSI2 is eventually
 * consistent, so current task cards must use taskIdsForCurrentCondition.
 * @param {Parameters<typeof supersedeOpenTasksForCondition>[0]} opts
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function findOpenConditionTasks(opts) {
  /** @type {Record<string, unknown>[]} */
  const matches = [];
  /** @type {Record<string, unknown> | undefined} */
  let exclusiveStartKey;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: opts.tableName,
        IndexName: GSI2_NAME,
        KeyConditionExpression: "gsi2pk = :worklist",
        FilterExpression: "#conditionId = :conditionId",
        ExpressionAttributeNames: {
          "#conditionId": "conditionId",
        },
        ExpressionAttributeValues: {
          ":worklist": taskWorklistPk(opts.siteId, "open"),
          ":conditionId": opts.conditionId,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    matches.push(...(result.Items ?? []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return matches;
}

/**
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {Record<string, string>[]} opts.keys
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function batchGetAll({ tableName, keys }) {
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

/** Receipt identity is evidence-scoped, independent of assessment revisions.
 * @param {string} siteId @param {Record<string, any>} assessment @param {Record<string, any>} condition
 */
export function conditionDeletionKey(siteId, assessment, condition) {
  const artifactId =
    condition.source?.artifactIds?.[0] || condition.sourceArtifactIds?.[0];
  const checkId = condition.checkId || assessment.checkId;
  return artifactId && checkId && condition.conditionId
    ? {
        pk: `SITE#${siteId}`,
        sk: `ISSUE_DELETION#${checkId}:${artifactId}:${condition.conditionId}`,
      }
    : null;
}

/** Project durable dismissals onto guidance without changing its stored policy outcome.
 * @param {string} tableName @param {string} siteId
 * @param {{assessment: Record<string, any> | null, conditions: Record<string, any>[], tasks: Record<string, any>[]}} guidance
 */
export async function withConditionDismissals(tableName, siteId, guidance) {
  const keys = [...guidance.conditions, ...guidance.tasks].flatMap(
    (condition) => {
      const key = conditionDeletionKey(
        siteId,
        guidance.assessment || {},
        condition,
      );
      return key ? [key] : [];
    },
  );
  const evidenceKeys = [
    ...guidance.conditions,
    ...guidance.tasks.filter((task) => evidenceIds(task).length === 1),
  ].flatMap((row) => {
    const checkId = row.checkId || guidance.assessment?.checkId;
    const ids = evidenceIds(row);
    return checkId
      ? ids.map((id) => evidenceDeletionKey(siteId, String(checkId), id))
      : [];
  });
  keys.push(...evidenceKeys);
  const receipts = keys.length
    ? await batchGetAll({
        tableName,
        keys: [...new Map(keys.map((key) => [key.sk, key])).values()],
      })
    : [];
  const dismissed = new Map(
    receipts
      .filter((row) => row.deletedAt || row.dismissedAt)
      .map((row) => [row.sk, row]),
  );
  return {
    ...guidance,
    tasks: guidance.tasks.map((task) => {
      const receipt = dismissed.get(
        conditionDeletionKey(siteId, guidance.assessment || {}, task)?.sk,
      );
      const ids = evidenceIds(task);
      const evidenceRemoved =
        ids.length === 1 &&
        task.checkId &&
        dismissed.has(evidenceDeletionKey(siteId, task.checkId, ids[0]).sk) &&
        retractableTask(task, ids[0]);
      if (!receipt && !evidenceRemoved) return task;
      return {
        ...task,
        status: "superseded",
        updatedAt: String(
          receipt?.dismissedAt || receipt?.deletedAt || task.updatedAt,
        ),
      };
    }),
    conditions: guidance.conditions.map((condition) =>
      (evidenceIds(condition).length > 0 &&
        (condition.checkId || guidance.assessment?.checkId) &&
        evidenceIds(condition).every((id) =>
          dismissed.has(
            evidenceDeletionKey(
              siteId,
              condition.checkId || guidance.assessment?.checkId,
              id,
            ).sk,
          ),
        )) ||
      dismissed.has(
        conditionDeletionKey(siteId, guidance.assessment || {}, condition)?.sk,
      )
        ? { ...condition, status: "rejected", needsAnswer: null }
        : condition,
    ),
  };
}
