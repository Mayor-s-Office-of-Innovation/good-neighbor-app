import { sf311Job } from "../analysis/guidance/sf311-job.js";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { catalogForPolicyVersion } from "../analysis/guidance/catalog-registry.js";
import { completeTaskWithAppActions } from "../analysis/guidance/guidance-store.js";
import { summarizeAppActionResults } from "../analysis/guidance/app-actions.js";
import { sharedActionTarget } from "../analysis/duplicates/links.js";
import { getConfig } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import {
  taskKey,
  taskUpdateKey,
  taskUpdateTimelineGsi,
  taskWorklistDateGsi,
} from "./keys.js";

/** @param {string} table @param {string} siteId @param {string} taskId */
async function readTask(table, siteId, taskId) {
  return (
    await ddb.send(
      new GetCommand({
        TableName: table,
        Key: taskKey(siteId, taskId),
        ConsistentRead: true,
      }),
    )
  ).Item;
}

/** @param {string} table @param {string} siteId @param {string} prefix */
async function duplicateRows(table, siteId, prefix) {
  const items = [];
  let exclusiveStartKey;
  do {
    /** @type {any} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": prefix,
        },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/** Resolve a clicked task to the root and every still-linked group member.
 * @param {string} table @param {string} siteId @param {Record<string, any>} clickedTask
 */
async function groupForTask(table, siteId, clickedTask) {
  const [savedLinks, overrides] = await Promise.all([
    duplicateRows(table, siteId, "DUP_LINK#"),
    duplicateRows(table, siteId, "DUP_OVERRIDE#"),
  ]);
  const separated = new Set(overrides.map((override) => override.taskId));
  const links = savedLinks.filter((link) => !separated.has(link.taskId));
  const clickedLink = links.find((link) => link.taskId === clickedTask.taskId);
  const rootTaskId = String(clickedLink?.originalTaskId ?? clickedTask.taskId);
  const memberLinks = links.filter(
    (link) => String(link.originalTaskId) === rootTaskId,
  );
  const ids = [rootTaskId, ...memberLinks.map((link) => String(link.taskId))];
  const tasks = /** @type {Record<string, any>[]} */ (
    await Promise.all(
      [...new Set(ids)].map((id) => readTask(table, siteId, id)),
    )
  ).filter(Boolean);
  return {
    rootTaskId,
    root: tasks.find((task) => task.taskId === rootTaskId),
    members: tasks
      .map((task) => ({
        ...task,
        isDuplicate: task.taskId !== rootTaskId,
        ...(memberLinks.find((link) => link.taskId === task.taskId) ?? {}),
      }))
      .sort((a, b) =>
        String(/** @type {Record<string, any>} */ (b).createdAt).localeCompare(
          String(/** @type {Record<string, any>} */ (a).createdAt),
        ),
      ),
  };
}

/** @param {Record<string, any>} task */
function actionOptions(task) {
  const catalog = catalogForPolicyVersion(String(task.policyVersion ?? ""));
  const seen = new Set();
  const rules = catalog.rules.filter(
    (rule) => rule.category === task.category && rule.outcome.buttons[0],
  );
  /** @param {any} rule */
  const signature = (rule) =>
    JSON.stringify({
      buttons: rule.outcome.buttons,
      appActions: rule.outcome.appActions,
      kind: rule.outcome.kind,
      phoneNumber: rule.outcome.phoneNumber ?? "",
      category311: rule.outcome.category311 ?? "",
      canBeInProgress: rule.canBeInProgress,
      primaryInProgressAgency: rule.primaryInProgressAgency ?? "",
    });
  const options = rules
    .filter((rule) => {
      const value = signature(rule);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .map((rule) => ({
      ruleId: rule.ruleId,
      label: rule.outcome.buttons[0],
    }));
  const selectedRuleId = task.actionOverride?.ruleId ?? task.ruleId;
  const selected = rules.find((rule) => rule.ruleId === selectedRuleId);
  const canonical = selected
    ? rules.find((rule) => signature(rule) === signature(selected))
    : undefined;
  return { options, selectedRuleId: canonical?.ruleId ?? selectedRuleId };
}

/** @param {unknown} error */
function isConditionalConflict(error) {
  return (
    error instanceof Error &&
    error.name === "TransactionCanceledException" &&
    /** @type {{CancellationReasons?:Array<{Code?:string}>}} */ (
      error
    ).CancellationReasons?.some(
      (reason) => reason.Code === "ConditionalCheckFailed",
    )
  );
}

/** @param {unknown} results */
function hasExecutedAction(results) {
  return (
    Array.isArray(results) &&
    results.some((result) =>
      ["submitted", "recorded", "closed", "partial"].includes(result?.status),
    )
  );
}

/** GET /v1/tasks/{taskId}/details @param {any} event */
export const getTaskDetails = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = event.pathParameters?.taskId;
  if (!taskId) return jsonResponse(400, { error: "Missing taskId" });
  const clicked = await readTask(dynamoTable, siteId, taskId);
  if (!clicked) return jsonResponse(404, { error: "Task not found" });
  const group = await groupForTask(dynamoTable, siteId, clicked);
  if (!group.root) return jsonResponse(409, { error: "Issue group changed" });
  const selection = actionOptions(group.root);
  return jsonResponse(200, {
    clicked,
    rootTaskId: group.rootTaskId,
    members: group.members,
    actions: selection.options,
    selectedRuleId:
      group.root.actionOverride?.type === "custom"
        ? "__custom__"
        : selection.selectedRuleId,
    customAction: group.root.customAction ?? null,
  });
};

/** PATCH /v1/tasks/{taskId}/action @param {any} event */
export const updateTaskAction = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const clickedId = event.pathParameters?.taskId;
  if (!clickedId) return jsonResponse(400, { error: "Missing taskId" });
  /** @type {any} */ let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }
  const ruleId = typeof body?.ruleId === "string" ? body.ruleId : "";
  const shared = await sharedActionTarget(dynamoTable, siteId, clickedId);
  const task = await readTask(dynamoTable, siteId, shared.taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  if (task.status !== "open")
    return jsonResponse(409, { error: "Task is no longer open" });
  if (hasExecutedAction(task.appActionResults))
    return jsonResponse(409, { error: "An action has already been taken" });
  const rule = catalogForPolicyVersion(
    String(task.policyVersion ?? ""),
  ).rules.find(
    (candidate) =>
      candidate.ruleId === ruleId && candidate.category === task.category,
  );
  if (!rule || !rule.outcome.buttons[0])
    return jsonResponse(400, { error: "Action is not available" });
  const now = new Date().toISOString();
  const updated = {
    ...task,
    actionOverride: {
      ruleId: rule.ruleId,
      originalRuleId: task.actionOverride?.originalRuleId ?? task.ruleId,
      selectedAt: now,
      selectedBy: deriveActorId(event),
    },
    canBeInProgress: rule.canBeInProgress,
    primaryInProgressAgency: rule.primaryInProgressAgency,
    ...(rule.maxAcceptableResponseHours === undefined
      ? { maxAcceptableResponseHours: undefined }
      : { maxAcceptableResponseHours: rule.maxAcceptableResponseHours }),
    kind: rule.outcome.kind,
    type: rule.outcome.kind === "action" ? "onsite" : "city_escalation",
    label: rule.outcome.label,
    guidance: rule.outcome.guidance,
    buttons: rule.outcome.buttons,
    appActions: rule.outcome.appActions,
    appActionStatus: rule.outcome.appActions.length
      ? "not_started"
      : "not_required",
    appActionResults: [],
    category311: rule.outcome.category311,
    phoneNumber: rule.outcome.phoneNumber ?? "",
    updatedAt: now,
    ...taskWorklistDateGsi(
      siteId,
      "open",
      rule.outcome.kind,
      Number(task.severity ?? 0),
      String(task.createdAt),
      task.taskId,
    ),
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...shared.duplicateChecks,
          ...sf311Job(dynamoTable, siteId, updated, `edited-${now}`),
          {
            ConditionCheck: {
              TableName: dynamoTable,
              Key: { pk: `SITE#${siteId}`, sk: `SF311_LOCK#${task.taskId}` },
              // The worker claims this item before reading the action selection.
              // Durable results also block edits after an uncertain external call.
              ConditionExpression:
                "attribute_not_exists(sf311Lease) AND attribute_not_exists(results)",
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: updated,
              ConditionExpression:
                "#status = :open AND updatedAt = :updated AND " +
                (task.appActionResults
                  ? "appActionResults = :results"
                  : "attribute_not_exists(appActionResults)"),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":open": "open",
                ":updated": task.updatedAt,
                ...(task.appActionResults
                  ? { ":results": task.appActionResults }
                  : {}),
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalConflict(error))
      return jsonResponse(409, { error: "Task changed while editing" });
    throw error;
  }
  return jsonResponse(200, { task: updated });
};

/** POST /v1/tasks/{taskId}/custom-action @param {any} event */
export const recordCustomTaskAction = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const clickedId = event.pathParameters?.taskId;
  if (!clickedId) return jsonResponse(400, { error: "Missing taskId" });
  /** @type {any} */ let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const resolved = body?.resolved;
  if (!text || text.length > 1000 || typeof resolved !== "boolean")
    return jsonResponse(400, { error: "Text and resolved are required" });
  const shared = await sharedActionTarget(dynamoTable, siteId, clickedId);
  const task = await readTask(dynamoTable, siteId, shared.taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  if (task.status !== "open")
    return jsonResponse(409, { error: "Task is no longer open" });
  const now = new Date().toISOString();
  const updateId = randomUUID();
  if (resolved) {
    try {
      const completed = await completeTaskWithAppActions({
        tableName: dynamoTable,
        siteId,
        taskId: task.taskId,
        completionMethod: "custom_action",
        actorId: deriveActorId(event),
        duplicateChecks: shared.duplicateChecks,
        forceComplete: true,
        skipUserConfirmedActions: true,
        taskPatch: {
          customAction: { text, resolved, recordedAt: now },
          canBeInProgress: false,
          appActions: [],
          actionOverride: {
            type: "custom",
            originalRuleId: task.actionOverride?.originalRuleId ?? task.ruleId,
            selectedAt: now,
            selectedBy: deriveActorId(event),
          },
        },
        timelineType: "task_completed",
        timelineLabel: "Site marked as resolved",
        timelineText: text,
        now: new Date(now),
      });
      return jsonResponse(200, { task: completed });
    } catch (error) {
      if (
        error instanceof Error &&
        ["TerminalConflict", "TaskCompletionInProgress"].includes(error.name)
      )
        return jsonResponse(409, { error: "Task changed while editing" });
      throw error;
    }
  }
  const status = "in_progress";
  const label = "Other action taken";
  const updated = {
    ...task,
    status,
    customAction: { text, resolved, recordedAt: now },
    actionOverride: {
      type: "custom",
      originalRuleId: task.actionOverride?.originalRuleId ?? task.ruleId,
      selectedAt: now,
      selectedBy: deriveActorId(event),
    },
    canBeInProgress: !resolved,
    appActions: [],
    appActionStatus: summarizeAppActionResults(task.appActionResults ?? []),
    appActionResults: task.appActionResults ?? [],
    latestUpdateId: updateId,
    latestUpdateLabel: label,
    inProgressAt: now,
    notifiedAt: now,
    agency: "other",
    inProgressActionKind: "custom_action",
    lastAnsweredPresencePeriod: 0,
    updatedAt: now,
    ...taskWorklistDateGsi(
      siteId,
      status,
      String(task.kind),
      Number(task.severity ?? 0),
      String(task.createdAt),
      task.taskId,
    ),
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...shared.duplicateChecks,
          {
            Put: {
              TableName: dynamoTable,
              Item: updated,
              ConditionExpression:
                "#status = :open AND updatedAt = :updated AND " +
                (task.appActionResults
                  ? "appActionResults = :results"
                  : "attribute_not_exists(appActionResults)"),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":open": "open",
                ":updated": task.updatedAt,
                ...(task.appActionResults
                  ? { ":results": task.appActionResults }
                  : {}),
              },
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: {
                ...taskUpdateKey(siteId, task.taskId, now, updateId),
                ...taskUpdateTimelineGsi(siteId, now, updateId),
                entityType: "task_update",
                taskId: task.taskId,
                updateId,
                type: resolved ? "task_completed" : "custom_action_taken",
                label,
                text,
                occurredAt: now,
                actorId: deriveActorId(event),
                documentationState: "closed",
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalConflict(error))
      return jsonResponse(409, { error: "Task changed while editing" });
    throw error;
  }
  return jsonResponse(200, { task: updated });
};
