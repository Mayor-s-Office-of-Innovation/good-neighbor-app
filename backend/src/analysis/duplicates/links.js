import { LOOKBACK_MS } from "./image-matcher.js";
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { analysisRevision, projectionKey } from "./jobs.js";
import { findOriginalIssue } from "./original-issue.js";
import {
  taskKey,
  taskUpdateKey,
  taskUpdateTimelineGsi,
  taskWorklistDateGsi,
} from "../../handlers/keys.js";

/** @typedef {Record<string, any>} Item */
/** @param {string} table @param {string} site */
export function siteReader(table, site) {
  /** @param {{pk:string,sk:string}} key @returns {Promise<Item|undefined>} */
  return async (key) => {
    if (key.pk !== `SITE#${site}`)
      throw new Error("Cross-site duplicate reference");
    return (
      await ddb.send(
        new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
      )
    ).Item;
  };
}
/** @param {string} site @param {Item} task */
export function overrideKey(site, task) {
  return {
    pk: `SITE#${site}`,
    sk: `DUP_OVERRIDE#${JSON.stringify([task.checkId, task.sourceArtifactIds?.[0], task.conditionId])}`,
  };
}
/** Resolve a condition through the current guidance pointer, never through a display ID.
 * @param {string} site @param {Item} ref @param {ReturnType<typeof siteReader>} get
 */
export async function taskForIssue(site, ref, get) {
  const [checkId, artifactId, extra] = String(ref.observationId).split(":");
  if (!checkId || !artifactId || extra) return null;
  const pointer = await get({
    pk: `SITE#${site}`,
    sk: `GUIDANCE_CURRENT#${JSON.stringify([checkId, artifactId])}`,
  });
  let assessmentId = pointer?.assessmentId;
  if (!assessmentId) {
    const legacy = await get({
      pk: `SITE#${site}`,
      sk: `ASSESSMENT#${checkId}-${artifactId}`,
    });
    if (
      !legacy ||
      legacy.supersededByAssessmentId ||
      legacy.checkId !== checkId ||
      legacy.rawAssessment?.artifactId !== artifactId
    )
      return null;
    assessmentId = legacy.assessmentId;
  }
  const condition = await get({
    pk: `SITE#${site}`,
    sk: `ASSESSMENT#${assessmentId}#COND#${ref.conditionId}`,
  });
  if (!condition?.taskIds?.length) return null;
  for (const id of condition.taskIds) {
    const task = await get(taskKey(site, id));
    if (
      task &&
      task.checkId === checkId &&
      task.conditionId === ref.conditionId &&
      task.sourceArtifactIds?.includes(artifactId) &&
      !["superseded", "deleted"].includes(task.status)
    )
      return task;
  }
  return null;
}
/** Read and revalidate persisted model evidence; no model calls or writes.
 * @param {string} table @param {string} site @param {Item} task
 * @param {ReturnType<typeof siteReader>} [reader]
 * @returns {Promise<Item>}
 */
export async function duplicateForTask(table, site, task, reader) {
  const get = reader ?? siteReader(table, site);
  const artifactId = task.sourceArtifactIds?.[0];
  if (!task.checkId || !artifactId || !task.conditionId)
    return { state: "not_applicable" };
  if (await get(overrideKey(site, task))) return { state: "separated" };
  const id = `${task.checkId}:${artifactId}`;
  const analysisKey = {
    pk: `SITE#${site}`,
    sk: `CHECK#${task.checkId}#ANALYSIS#${artifactId}`,
  };
  const analysis = await get(analysisKey);
  if (
    !analysis ||
    analysis.status !== "analyzed" ||
    !Number.isFinite(Date.parse(analysis.generatedAt ?? analysis.analyzedAt))
  )
    return {
      state: "pending",
      pendingSince: analysis?.analyzedAt ?? task.createdAt,
    };
  const revision = analysisRevision(analysis);
  // Read timing before projection checks: a newly queued revision may not have
  // an observation yet. Task age is unrelated to this job's age.
  const result = await get({
    pk: analysisKey.pk,
    sk: `DUP_RESULT#${id}#${revision}`,
  });
  const pendingSince =
    [result?.queuedAt, result?.recoveryRequestedAt]
      .filter((value) => Number.isFinite(Date.parse(value)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1) ??
    result?.invalidatedAt ??
    analysis.analyzedAt;
  const pending = { state: "pending", pendingSince };
  const artifact = await get({
    pk: analysisKey.pk,
    sk: `CHECK#${task.checkId}#ART#${artifactId}`,
  });
  const projection = await get(
    projectionKey(site, analysis.generatedAt ?? analysis.analyzedAt, id),
  );
  if (
    !artifact ||
    !projection ||
    projection.revision !== revision ||
    projection.supersededAt
  )
    return pending;
  const current = await taskForIssue(
    site,
    { observationId: id, conditionId: task.conditionId },
    get,
  );
  if (current?.taskId !== task.taskId) return { state: "not_applicable" };
  const incremental = await get({
    pk: analysisKey.pk,
    sk: `DUP_ISSUE#${id}#${revision}#${task.conditionId}`,
  });
  const row =
    incremental?.possibleDuplicate === true &&
    (!result?.invalidatedAt || incremental.updatedAt > result.invalidatedAt)
      ? incremental
      : result?.conditionResults?.find(
          (/** @type {Item} */ c) => c.conditionId === task.conditionId,
        );
  if (row?.possibleDuplicate !== true || row.matchStrength !== "strong")
    return {
      pendingSince,
      state:
        result?.recoveryRequestedAt &&
        (!result.evaluatedAt || result.recoveryRequestedAt > result.evaluatedAt)
          ? "pending"
          : row?.assessmentOutcome === "no_match_with_failures"
            ? "unavailable"
            : result?.processingState === "complete" ||
                result?.status === "evaluated"
              ? "complete"
              : "pending",
    };
  const [directCheck, directArtifact, extra] = String(
    row.duplicateOf?.observationId,
  ).split(":");
  if (!directCheck || !directArtifact || extra) return pending;
  const directAnalysis = await get({
    pk: analysisKey.pk,
    sk: `CHECK#${directCheck}#ANALYSIS#${directArtifact}`,
  });
  const age =
    Date.parse(analysis.generatedAt ?? analysis.analyzedAt) -
    Date.parse(directAnalysis?.generatedAt ?? directAnalysis?.analyzedAt);
  if (!Number.isFinite(age) || age < 0 || age >= LOOKBACK_MS)
    return { state: "complete" };
  const original = await findOriginalIssue({
    siteId: site,
    category: analysis.concerns.find(
      (/** @type {Item} */ c) => c.conditionId === task.conditionId,
    )?.category,
    sourceTime: analysis.generatedAt ?? analysis.analyzedAt,
    direct: row.duplicateOf,
    get,
  });
  if (!original.originalIssue) return pending;
  const root = await taskForIssue(site, original.originalIssue, get);
  if (
    root?.resolvedAt &&
    Date.parse(root.resolvedAt) <=
      Date.parse(analysis.generatedAt ?? analysis.analyzedAt)
  )
    return { state: "complete" };
  if (!root || root.taskId === task.taskId) return pending;
  return {
    state: "matched",
    original: root,
    originalIssue: original.originalIssue,
    duplicateOf: row.duplicateOf,
    sourceRevision: revision,
    analysisKey,
    analysis,
    detectedAt: incremental?.updatedAt ?? result?.evaluatedAt,
    generatedAt: analysis.generatedAt ?? analysis.analyzedAt,
  };
}
/** Persist an idempotent link and timeline event after either analysis or guidance arrives.
 * @param {string} table @param {string} site @param {string} checkId @param {string} artifactId
 */
export async function reconcileObservation(table, site, checkId, artifactId) {
  const get = siteReader(table, site),
    pk = `SITE#${site}`;
  const analysis = await get({
    pk,
    sk: `CHECK#${checkId}#ANALYSIS#${artifactId}`,
  });
  if (!analysis) return;
  for (const c of analysis.concerns ?? []) {
    if (!c.conditionId || c.rating <= 0) continue;
    const task = await taskForIssue(
      site,
      { observationId: `${checkId}:${artifactId}`, conditionId: c.conditionId },
      get,
    );
    if (!task) continue;
    const relation = await duplicateForTask(table, site, task);
    if (relation.state !== "matched") continue;
    const root = relation.original;
    const updateId = `duplicate-${createHash("sha256").update(`${task.taskId}:${relation.sourceRevision}:${root.taskId}`).digest("hex").slice(0, 32)}`;
    const occurredAt = relation.detectedAt ?? analysis.analyzedAt;
    const link = {
      pk,
      sk: `DUP_LINK#${task.taskId}`,
      taskId: task.taskId,
      originalTaskId: root.taskId,
      sourceRevision: relation.sourceRevision,
      updateId,
      occurredAt,
    };
    const previous = await get({ pk, sk: link.sk });
    const adoptAction =
      root.status === "open" &&
      ["in_progress", "completed", "cannot_do"].includes(task.status);
    if (previous?.updateId === updateId && !adoptAction) continue;
    const actionFields = [
      "status",
      "completedAt",
      "completionMethod",
      "inProgressAt",
      "notifiedAt",
      "agency",
      "inProgressActionKind",
      "latestUpdateId",
      "latestUpdateLabel",
      "lastAnsweredPresencePeriod",
      "appActionStatus",
      "appActionResults",
      "canBeInProgress",
      "resolvedAt",
      "cannotDo",
    ];
    const adoptedUpdateId = `adopt-${task.taskId}`;
    const actionAt = task.inProgressAt ?? task.completedAt ?? task.updatedAt;
    const adopted = adoptAction
      ? {
          ...root,
          ...Object.fromEntries(
            actionFields
              .filter((key) => task[key] !== undefined)
              .map((key) => [key, task[key]]),
          ),
          updatedAt: task.updatedAt,
          latestUpdateId: adoptedUpdateId,
          ...taskWorklistDateGsi(
            site,
            task.status,
            root.kind,
            root.severity,
            task.updatedAt,
            root.taskId,
          ),
        }
      : null;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...(adopted
              ? [
                  {
                    Put: {
                      TableName: table,
                      Item: adopted,
                      ConditionExpression:
                        "#status = :open AND updatedAt = :updated",
                      ExpressionAttributeNames: { "#status": "status" },
                      ExpressionAttributeValues: {
                        ":open": "open",
                        ":updated": root.updatedAt,
                      },
                    },
                  },
                ]
              : []),
            ...(adopted
              ? [
                  {
                    Put: {
                      TableName: table,
                      Item: {
                        ...taskUpdateKey(
                          site,
                          root.taskId,
                          actionAt,
                          adoptedUpdateId,
                        ),
                        ...taskUpdateTimelineGsi(
                          site,
                          actionAt,
                          adoptedUpdateId,
                        ),
                        entityType: "task_update",
                        taskId: root.taskId,
                        updateId: adoptedUpdateId,
                        type:
                          task.status === "in_progress"
                            ? "escalation_action_taken"
                            : "task_completed",
                        label: task.latestUpdateLabel ?? "Marked as complete",
                        occurredAt: actionAt,
                        actionSourceTaskId: task.taskId,
                        documentationState: "closed",
                      },
                    },
                  },
                ]
              : []),
            {
              ConditionCheck: {
                TableName: table,
                Key: taskKey(site, task.taskId),
                ConditionExpression:
                  "#status = :status AND updatedAt = :updated",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":status": task.status,
                  ":updated": task.updatedAt,
                },
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: overrideKey(site, task),
                ConditionExpression: "attribute_not_exists(sk)",
              },
            },
            {
              ConditionCheck: {
                TableName: table,
                Key: relation.analysisKey,
                ConditionExpression:
                  "analysisId = :id AND concerns = :concerns",
                ExpressionAttributeValues: {
                  ":id": analysis.analysisId,
                  ":concerns": analysis.concerns,
                },
              },
            },
            {
              Put: {
                TableName: table,
                Item: link,
                ConditionExpression: previous
                  ? "updateId = :previous"
                  : "attribute_not_exists(sk)",
                ...(previous
                  ? {
                      ExpressionAttributeValues: {
                        ":previous": previous.updateId,
                      },
                    }
                  : {}),
              },
            },
            {
              Put: {
                TableName: table,
                Item: {
                  ...taskUpdateKey(site, root.taskId, occurredAt, updateId),
                  ...taskUpdateTimelineGsi(site, occurredAt, updateId),
                  entityType: "task_update",
                  taskId: root.taskId,
                  updateId,
                  type: "duplicate_detected",
                  occurredAt,
                  sourceTaskId: task.taskId,
                  sourceCheckId: checkId,
                  sourceArtifactId: artifactId,
                  sourceConditionId: c.conditionId,
                  sourceRevision: relation.sourceRevision,
                },
                ConditionExpression:
                  "attribute_not_exists(sk) OR updateId = :event",
                ExpressionAttributeValues: { ":event": updateId },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "TransactionCanceledException"
      )
        throw error;
      // A concurrent separation/link revision wins; retry other transient conflicts.
      const saved = await get({ pk, sk: link.sk });
      if (
        !(await get(overrideKey(site, task))) &&
        (saved?.updateId !== updateId ||
          (adopted &&
            (await get(taskKey(site, root.taskId)))?.status === "open"))
      )
        throw error;
    }
  }
}
/** Authoritative shared-action target. The existing completion lease serializes the group.
 * @param {string} table @param {string} site @param {string} taskId
 * @returns {Promise<{taskId:string,duplicateChecks:any[]}>}
 */
export async function sharedActionTarget(table, site, taskId) {
  if (
    process.env.DUPLICATE_DETECTION_ENABLED !== "true" &&
    !(await siteReader(
      table,
      site,
    )({ pk: `SITE#${site}`, sk: `DUP_LINK#${taskId}` }))
  )
    return { taskId, duplicateChecks: [] };
  const task = await siteReader(table, site)(taskKey(site, taskId));
  if (!task) return { taskId, duplicateChecks: [] };
  const base = siteReader(table, site);
  /** @type {Map<string,{key:{pk:string,sk:string},item:Item|undefined}>} */ const trace =
    new Map();
  /** @param {{pk:string,sk:string}} key */
  const get = async (key) => {
    const item = await base(key);
    trace.set(key.sk, { key, item });
    return item;
  };
  const relation = await duplicateForTask(table, site, task, get);
  if (relation.state !== "matched") return { taskId, duplicateChecks: [] };
  /** @type {any[]} */ const checks = [];
  for (const { key, item } of trace.values()) {
    if (
      !/^(DUP_OVERRIDE#|DUP_ISSUE#|DUP_RESULT#|DUP_OBSERVATION#|CHECK#)/.test(
        key.sk,
      )
    )
      continue;
    let expression = "attribute_not_exists(sk)";
    /** @type {Record<string,any>} */ const values = {};
    if (item) {
      expression = "attribute_exists(sk)";
      for (const field of [
        "analysisId",
        "analyzedAt",
        "generatedAt",
        "concerns",
        "revision",
        "updatedAt",
        "duplicateOf",
        "evaluatedAt",
        "invalidatedAt",
        "resolvedAt",
        "supersededAt",
      ]) {
        if (item[field] !== undefined) {
          expression += ` AND ${field} = :${field}`;
          values[`:${field}`] = item[field];
        } else if (
          ["invalidatedAt", "resolvedAt", "supersededAt"].includes(field)
        )
          expression += ` AND attribute_not_exists(${field})`;
      }
    }
    checks.push({
      ConditionCheck: {
        TableName: table,
        Key: key,
        ConditionExpression: expression,
        ...(Object.keys(values).length
          ? { ExpressionAttributeValues: values }
          : {}),
      },
    });
  }
  // DynamoDB limits a transaction to 100 distinct items. Fail closed rather
  // than dropping reference/override guards on an unusually deep chain.
  if (checks.length > 95)
    throw Object.assign(
      new Error("Duplicate chain is too deep for a shared action"),
      { name: "TerminalConflict" },
    );
  return {
    taskId: relation.original.taskId,
    duplicateChecks: checks,
  };
}
