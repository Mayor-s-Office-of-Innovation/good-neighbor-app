import {
  deletionScope,
  selectedDeletionScope,
  checkDeletionSize,
} from "../analysis/duplicates/deletion.js";
import { readTask, groupForTask } from "../analysis/duplicates/group.js";
import { inactiveSf311Lease } from "../domain/sf311-lease.js";
import {
  descriptionWrites,
  descriptionPatch,
  taskDescriptionWrite,
  validDescription,
  validTitle,
  silent311Snapshot,
} from "./description-edits.js";
import { sf311Job } from "../analysis/guidance/sf311-job.js";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { catalogForPolicyVersion } from "../analysis/guidance/catalog-registry.js";
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

/** @param {Record<string, any>} task */
export function actionOptions(task) {
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
      category: rule.category,
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
      files311: rule.outcome.appActions.some(
        (action) =>
          action.code === "create_311_ticket" &&
          action.payload?.executionTrigger === "user_confirmed",
      ),
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

/** Silent filing history survives an edit unchanged, including unfinished uploads
 * and reconciliation checkpoints. Executed user actions still prevent overrides.
 * @param {Array<Record<string, any>>} results
 */
function editableActionResults(results) {
  return results.every((result) => {
    if (
      result.code === "create_311_ticket" &&
      result.payload?.executionTrigger === "task_created" &&
      String(result.payload?.responsibleAgencyCode) === "76"
    )
      return true;
    if (/uncertain|reconciliation/.test(String(result.reason || "")))
      return false;
    return ["skipped", "not_configured", "requires_user_action"].includes(
      result.status,
    );
  });
}

/** Category/action choices contain no guidance; guidance is published on Save.
 * @param {Record<string, any>} task
 */
export function categoryOptions(task) {
  const catalog = catalogForPolicyVersion(String(task.policyVersion || ""));
  return [
    ...new Set(
      catalog.rules
        .filter((rule) => rule.outcome.buttons[0])
        .map((rule) => rule.category),
    ),
  ].map((category) => ({
    category,
    actions: actionOptions({ ...task, category }).options,
  }));
}

/** GET /v1/tasks/{taskId}/details @param {any} event */
export const getTaskDetails = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = event.pathParameters?.taskId;
  if (!taskId) return jsonResponse(400, { error: "Missing taskId" });
  const clicked = await readTask(dynamoTable, siteId, taskId);
  if (!clicked) return jsonResponse(404, { error: "Task not found" });
  if (
    ["deletion", "selected"].includes(event.queryStringParameters?.view || "")
  ) {
    try {
      const scope =
        event.queryStringParameters.view === "selected"
          ? selectedDeletionScope(clicked)
          : await deletionScope(dynamoTable, siteId, clicked);
      checkDeletionSize(siteId, scope);
      return jsonResponse(200, {
        deletion: { kind: scope.kind, targets: scope.targets },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "statusCode" in error &&
        error.statusCode === 409
      )
        return jsonResponse(409, {
          error: error.message,
          code: "code" in error ? error.code : "group_changed",
        });
      throw error;
    }
  }
  const group = await groupForTask(dynamoTable, siteId, clicked);
  if (!group.root) return jsonResponse(409, { error: "Issue group changed" });
  const selection = actionOptions(group.root);
  return jsonResponse(200, {
    clicked,
    editable:
      group.root.status === "open" &&
      clicked.status === "open" &&
      editableActionResults(group.root.appActionResults || []),
    category: group.root.category,
    categories: categoryOptions(group.root),
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
  if (
    body?.requestId !== undefined &&
    (typeof body.requestId !== "string" || body.requestId.length > 100)
  )
    return jsonResponse(400, { error: "Invalid requestId" });
  const title = body?.title;
  if (title !== undefined && !validTitle(title))
    return jsonResponse(400, { error: "Invalid title" });
  const description = body?.description;
  if (description !== undefined && !validDescription(description))
    return jsonResponse(400, { error: "Invalid description" });
  const clicked = await readTask(dynamoTable, siteId, clickedId);
  if (!clicked) return jsonResponse(404, { error: "Task not found" });
  if (clicked.status !== "open")
    return jsonResponse(409, { error: "Work has begun" });
  /** @type {Awaited<ReturnType<typeof descriptionWrites>>} */
  let edit = { writes: [], tasks: [], condition: null };
  try {
    if (description !== undefined || title !== undefined)
      edit = await descriptionWrites({
        table: dynamoTable,
        siteId,
        task: clicked,
        description: description ?? clicked.description,
        title,
      });
  } catch (error) {
    if (error instanceof Error && "status" in error)
      return jsonResponse(Number(error.status), { error: error.message });
    throw error;
  }
  if (!ruleId) {
    if (description === undefined && title === undefined)
      return jsonResponse(400, { error: "No changes" });
    const shared = await sharedActionTarget(dynamoTable, siteId, clickedId);
    const root =
      shared.taskId === clickedId
        ? clicked
        : await readTask(dynamoTable, siteId, shared.taskId);
    if (
      !root ||
      root.status !== "open" ||
      !editableActionResults(root.appActionResults || [])
    )
      return jsonResponse(409, { error: "Work has begun" });
    if (body.category !== undefined && body.category !== root.category)
      return jsonResponse(400, { error: "Select an action for the category" });
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...shared.duplicateChecks,
            ...(shared.taskId !== clickedId
              ? [
                  {
                    ConditionCheck: {
                      TableName: dynamoTable,
                      Key: taskKey(siteId, shared.taskId),
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
            ...edit.writes,
            taskDescriptionWrite(
              dynamoTable,
              clicked,
              description ?? clicked.description,
              title,
            ),
          ],
        }),
      );
    } catch (error) {
      if (isConditionalConflict(error))
        return jsonResponse(409, { error: "Task changed while editing" });
      throw error;
    }
    return jsonResponse(200, {
      task: {
        ...clicked,
        ...descriptionPatch(clicked, description ?? clicked.description),
        ...(title !== undefined
          ? { userFriendlyLabel: title.trim(), titleEdited: true }
          : {}),
      },
    });
  }

  const shared = await sharedActionTarget(dynamoTable, siteId, clickedId);
  const task = await readTask(dynamoTable, siteId, shared.taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  if (
    typeof body?.requestId === "string" &&
    body.requestId &&
    task.detailsEditId === body.requestId
  )
    return jsonResponse(200, { task });
  if (task.status !== "open")
    return jsonResponse(409, { error: "Task is no longer open" });
  if (!editableActionResults(task.appActionResults || []))
    return jsonResponse(409, { error: "An action has already been taken" });
  const rule = catalogForPolicyVersion(
    String(task.policyVersion ?? ""),
  ).rules.find(
    (candidate) =>
      candidate.ruleId === ruleId &&
      candidate.category === (body.category ?? task.category),
  );
  if (!rule || !rule.outcome.buttons[0])
    return jsonResponse(400, { error: "Action is not available" });
  const lockKey = { pk: `SITE#${siteId}`, sk: `SF311_LOCK#${task.taskId}` };
  const { Item: lock } = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: lockKey,
      ConsistentRead: true,
    }),
  );
  const priorResults =
    /** @type {import("../analysis/guidance/app-actions.js").AppActionResult[]} */ (
      task.appActionResults || []
    );
  const leaseGuard = inactiveSf311Lease(lock, new Date().toISOString());
  // Checkpoints stay on the lock even when the worker has not mirrored them
  // onto the task yet. Compare both snapshots at commit to avoid racing a worker.
  if (!leaseGuard || !editableActionResults(lock?.results || []))
    return jsonResponse(409, { error: "Task changed while editing" });
  const now = new Date().toISOString();
  const updated = {
    ...task,
    ...(typeof body?.requestId === "string"
      ? { detailsEditId: body.requestId }
      : {}),
    silent311Snapshot: silent311Snapshot(task),
    ...((description !== undefined || title !== undefined) &&
    clickedId === task.taskId
      ? {
          ...descriptionPatch(clicked, description ?? clicked.description),
          ...(title !== undefined
            ? { userFriendlyLabel: title.trim(), titleEdited: true }
            : {}),
        }
      : {}),
    actionOverride: {
      ruleId: rule.ruleId,
      originalRuleId: task.actionOverride?.originalRuleId ?? task.ruleId,
      selectedAt: now,
      selectedBy: deriveActorId(event),
    },
    category: rule.category,
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
    appActionStatus: priorResults.length
      ? summarizeAppActionResults(priorResults)
      : rule.outcome.appActions.length
        ? "not_started"
        : "not_required",
    appActionResults: priorResults,
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
          ...edit.writes,
          ...((description !== undefined || title !== undefined) &&
          clickedId !== task.taskId
            ? [
                taskDescriptionWrite(
                  dynamoTable,
                  clicked,
                  description ?? clicked.description,
                  title,
                ),
              ]
            : []),
          {
            ConditionCheck: {
              TableName: dynamoTable,
              Key: lockKey,
              // The worker claims this item before reading the action selection.
              // Compare the durable checkpoint as well as the task snapshot.
              ConditionExpression:
                leaseGuard.ConditionExpression +
                " AND " +
                (lock?.results !== undefined
                  ? "results = :lockResults"
                  : "attribute_not_exists(results)"),
              ...(lock?.results !== undefined ||
              Object.keys(leaseGuard.ExpressionAttributeValues).length
                ? {
                    ExpressionAttributeValues: {
                      ...leaseGuard.ExpressionAttributeValues,
                      ...(lock?.results !== undefined
                        ? { ":lockResults": lock.results }
                        : {}),
                    },
                  }
                : {}),
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
  if (
    typeof body?.requestId === "string" &&
    body.requestId &&
    task.detailsEditId === body.requestId
  )
    return jsonResponse(200, { task });
  if (task.status !== "open")
    return jsonResponse(409, { error: "Task is no longer open" });
  const lockKey = { pk: `SITE#${siteId}`, sk: `SF311_LOCK#${task.taskId}` };
  const { Item: lock } = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: lockKey,
      ConsistentRead: true,
    }),
  );
  const leaseGuard = inactiveSf311Lease(lock, new Date().toISOString());
  if (!leaseGuard)
    return jsonResponse(409, { error: "Task changed while editing" });
  const now = new Date().toISOString();
  const updateId = randomUUID();
  if (
    body?.requestId !== undefined &&
    (typeof body.requestId !== "string" || body.requestId.length > 100)
  )
    return jsonResponse(400, { error: "Invalid requestId" });
  const title = body?.title;
  if (title !== undefined && !validTitle(title))
    return jsonResponse(400, { error: "Invalid title" });
  const description = body?.description;
  if (description !== undefined && !validDescription(description))
    return jsonResponse(400, { error: "Invalid description" });
  const clicked =
    clickedId === task.taskId
      ? task
      : await readTask(dynamoTable, siteId, clickedId);
  if (!clicked) return jsonResponse(404, { error: "Task not found" });
  if (clicked.status !== "open")
    return jsonResponse(409, { error: "Work has begun" });
  /** @type {Awaited<ReturnType<typeof descriptionWrites>>} */
  let edit = { writes: [], tasks: [], condition: null };
  try {
    if (description !== undefined || title !== undefined)
      edit = await descriptionWrites({
        table: dynamoTable,
        siteId,
        task: clicked,
        description: description ?? clicked.description,
        title,
      });
  } catch (error) {
    if (error instanceof Error && "status" in error)
      return jsonResponse(Number(error.status), { error: error.message });
    throw error;
  }
  if (
    !editableActionResults(task.appActionResults || []) ||
    !editableActionResults(lock?.results || [])
  )
    return jsonResponse(409, { error: "Work has begun" });
  const category = body.category ?? task.category;
  if (!categoryOptions(task).some((option) => option.category === category))
    return jsonResponse(400, { error: "Invalid category" });
  const status = resolved ? "completed" : "in_progress";
  const label = resolved ? "Site marked as resolved" : "Other action taken";
  const updated = {
    ...task,
    status,
    ...(typeof body?.requestId === "string"
      ? { detailsEditId: body.requestId }
      : {}),
    silent311Snapshot: silent311Snapshot(task),
    ...((description !== undefined || title !== undefined) &&
    clickedId === task.taskId
      ? {
          ...descriptionPatch(clicked, description ?? clicked.description),
          ...(title !== undefined
            ? { userFriendlyLabel: title.trim(), titleEdited: true }
            : {}),
        }
      : {}),
    ...(resolved
      ? {
          completedAt: now,
          resolvedAt: now,
          proofAddedAt: null,
          completionMethod: "custom_action",
        }
      : {}),
    category,
    guidance: "",
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
    ...(!resolved
      ? {
          inProgressAt: now,
          notifiedAt: now,
          agency: "other",
          inProgressActionKind: "custom_action",
          lastAnsweredPresencePeriod: 0,
        }
      : {}),
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
            ConditionCheck: {
              TableName: dynamoTable,
              Key: lockKey,
              ConditionExpression:
                leaseGuard.ConditionExpression +
                " AND " +
                (lock?.results !== undefined
                  ? "results = :lockResults"
                  : "attribute_not_exists(results)"),
              ...(lock?.results !== undefined ||
              Object.keys(leaseGuard.ExpressionAttributeValues).length
                ? {
                    ExpressionAttributeValues: {
                      ...leaseGuard.ExpressionAttributeValues,
                      ...(lock?.results !== undefined
                        ? { ":lockResults": lock.results }
                        : {}),
                    },
                  }
                : {}),
            },
          },
          ...edit.writes,
          ...((description !== undefined || title !== undefined) &&
          clickedId !== task.taskId
            ? [
                taskDescriptionWrite(
                  dynamoTable,
                  clicked,
                  description ?? clicked.description,
                  title,
                ),
              ]
            : []),
          ...(resolved
            ? sf311Job(dynamoTable, siteId, updated, `resolved-${updateId}`)
            : []),
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
