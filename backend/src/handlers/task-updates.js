// @ts-nocheck -- Lambda handler event unions are validated at runtime below.
import { randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import {
  taskKey,
  artifactKey,
  checkHeaderKey,
  taskUpdateKey,
  taskUpdatePrefix,
  taskWorklistDateGsi,
} from "./keys.js";
import {
  notePhotoLabel,
  presencePeriod,
  presencePromptDue,
  qualifyingAction,
  responseExpectedAt,
} from "../domain/task-updates.js";

const MAX_PHOTOS = 6;
const MAX_NOTES = 3;
const MAX_TEXT = 4000;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function bodyOf(event) {
  try {
    const value = readJsonBody(event);
    return value && typeof value === "object" ? value : {};
  } catch {
    return null;
  }
}

function idempotencyId(event) {
  const raw =
    event.headers?.["idempotency-key"] ||
    event.headers?.["Idempotency-Key"] ||
    randomUUID();
  return (
    String(raw)
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 96) || randomUUID()
  );
}

function actorId(event) {
  const authorizer = event.requestContext?.authorizer || {};
  return String(
    authorizer.lambda?.["claims.sub"] ||
      authorizer["claims.sub"] ||
      authorizer.jwt?.claims?.sub ||
      "site-team",
  );
}

function textList(value, max) {
  if (!Array.isArray(value) || value.length > max) return null;
  const values = value.map((item) => String(item || "").trim());
  return values.every((item) => item && item.length <= MAX_TEXT)
    ? values
    : null;
}

function photoList(value) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) return null;
  const values = value.map((item) => String(item || "").trim());
  return values.every((item) => item && item.length <= 512) ? values : null;
}

async function getTask(tableName, siteId, taskId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: taskKey(siteId, taskId),
      ConsistentRead: true,
    }),
  );
  return result.Item || null;
}

async function getUpdateById(tableName, siteId, taskId, updateId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      FilterExpression: "updateId = :updateId",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": taskUpdatePrefix(taskId),
        ":updateId": updateId,
      },
    }),
  );
  return result.Items?.[0] || null;
}

function detail(task, updates) {
  return {
    task: {
      ...task,
      responseExpectedAt: responseExpectedAt(task),
      presencePeriod: presencePeriod(task.inProgressAt),
      presencePromptDue: presencePromptDue(task),
    },
    updates,
  };
}

/** GET /v1/tasks/{taskId}/updates */
export const getTaskUpdates = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  if (!taskId) return jsonResponse(400, { error: "Missing taskId" });
  const [task, timeline] = await Promise.all([
    getTask(dynamoTable, siteId, taskId),
    ddb.send(
      new QueryCommand({
        TableName: dynamoTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": taskUpdatePrefix(taskId),
        },
        ScanIndexForward: false,
      }),
    ),
  ]);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  const check = task.checkId
    ? (
        await ddb.send(
          new GetCommand({
            TableName: dynamoTable,
            Key: checkHeaderKey(siteId, task.checkId),
            ConsistentRead: true,
          }),
        )
      ).Item
    : null;
  // Reopening the card after an interrupted automatic documentation screen is
  // the server-observable equivalent of Skip. Seal those events before
  // returning them; a direct update can never amend an older presence event.
  const updates = await Promise.all(
    (timeline.Items || []).map(async (update) => {
      if (update.documentationState !== "open_for_documentation") return update;
      const sealed = {
        ...update,
        documentationState: "closed",
        documentedAt: new Date().toISOString(),
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: dynamoTable,
                  Item: sealed,
                  ConditionExpression: "documentationState = :open",
                  ExpressionAttributeValues: {
                    ":open": "open_for_documentation",
                  },
                },
              },
            ],
          }),
        );
        return sealed;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "TransactionCanceledException"
        )
          return update;
        throw error;
      }
    }),
  );
  return jsonResponse(200, {
    ...detail(task, updates),
    issueOrigin:
      check?.flowType === "single-problem" ? "single-problem" : "perimeter",
  });
};

/** POST /v1/tasks/{taskId}/start-progress */
export const startTaskProgress = async (event) => {
  const input = bodyOf(event);
  if (!input) return jsonResponse(400, { error: "Invalid JSON body" });
  const action = qualifyingAction(input.actionLabel);
  if (!action)
    return jsonResponse(400, { error: "Action does not start progress" });
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  const task = await getTask(dynamoTable, siteId, taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  if (
    ![
      ...(Array.isArray(task.buttons) ? task.buttons : []),
      ...(Array.isArray(task.appActions)
        ? task.appActions.map(
            (candidate) => candidate?.payload?.completionLabel,
          )
        : []),
    ].some((label) => String(label || "") === String(input.actionLabel))
  ) {
    return jsonResponse(400, { error: "Action is not available on this task" });
  }
  if (
    task.status === "in_progress" &&
    task.inProgressActionKind === action.actionKind
  ) {
    return getTaskUpdates(event);
  }
  if (task.status !== "open")
    return jsonResponse(409, { error: "Task is no longer open" });
  const now = new Date().toISOString();
  const updateId = idempotencyId(event);
  const update = {
    ...taskUpdateKey(siteId, taskId, now, updateId),
    entityType: "task_update",
    taskId,
    updateId,
    type: "escalation_action_taken",
    actionKind: action.actionKind,
    agency: action.agency,
    label: action.label,
    occurredAt: now,
    actorId: actorId(event),
    documentationState: "closed",
  };
  const updated = {
    ...task,
    status: "in_progress",
    inProgressAt: now,
    notifiedAt: now,
    agency: action.agency,
    inProgressActionKind: action.actionKind,
    latestUpdateId: updateId,
    latestUpdateLabel: action.label,
    lastAnsweredPresencePeriod: 0,
    updatedAt: now,
    ...taskWorklistDateGsi(
      siteId,
      "in_progress",
      String(task.kind || ""),
      Number(task.severity || 0),
      now,
      taskId,
    ),
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: dynamoTable,
              Item: update,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: updated,
              ConditionExpression: "#status = :open",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":open": "open" },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException")
      return jsonResponse(409, { error: "Task update conflict" });
    throw error;
  }
  return jsonResponse(200, detail(updated, [update]));
};

/** POST /v1/tasks/{taskId}/updates */
export const createTaskUpdate = async (event) => {
  const input = bodyOf(event);
  if (!input) return jsonResponse(400, { error: "Invalid JSON body" });
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  const task = await getTask(dynamoTable, siteId, taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  const updateId = idempotencyId(event);
  const priorUpdate = await getUpdateById(
    dynamoTable,
    siteId,
    taskId,
    updateId,
  );
  if (priorUpdate)
    return jsonResponse(200, {
      task: detail(task, [priorUpdate]).task,
      update: priorUpdate,
    });
  if (task.status !== "in_progress")
    return jsonResponse(409, { error: "Task is not in progress" });

  const type = String(input.type || "");
  const nowDate = new Date();
  const now = nowDate.toISOString();
  let label = "";
  let timelineLabel = "";
  let documentationState = "closed";
  let resolved = false;
  let period;
  let notes = [];
  let photoKeys = [];
  let text;

  if (type === "presence_still_present" || type === "presence_resolved") {
    period = presencePeriod(task.inProgressAt, nowDate);
    if (period < 1 || Number(task.lastAnsweredPresencePeriod || 0) >= period)
      return jsonResponse(409, { error: "Presence prompt is not due" });
    resolved = type === "presence_resolved";
    label = resolved ? "Resolved" : "Still present";
    timelineLabel = resolved ? "Site team marked as resolved" : "Still there";
    documentationState = "open_for_documentation";
  } else if (type === "note_photo_update") {
    const parsedNotes = textList(input.notes, MAX_NOTES);
    const parsedPhotos = photoList(input.photoKeys);
    if (!parsedNotes || !parsedPhotos)
      return jsonResponse(400, { error: "Invalid notes or photos" });
    label = notePhotoLabel(parsedNotes, parsedPhotos);
    if (!label)
      return jsonResponse(400, { error: "An update needs a note or photo" });
    timelineLabel = label;
    notes = parsedNotes;
    photoKeys = parsedPhotos;
  } else if (
    type === "additional_action_resolved" ||
    type === "additional_action_still_present"
  ) {
    text = String(input.text || "").trim();
    if (!text || text.length > MAX_TEXT)
      return jsonResponse(400, { error: "Invalid action" });
    resolved = type === "additional_action_resolved";
    label = resolved ? "Resolved" : "Still present";
    timelineLabel = "Additional action taken";
    documentationState = "open_for_documentation";
  } else if (type === "additional_action") {
    text = String(input.text || "").trim();
    const parsedPhotos = photoList(input.photoKeys);
    if (!text || text.length > MAX_TEXT || !parsedPhotos)
      return jsonResponse(400, { error: "Invalid action or photos" });
    label = "More action taken";
    timelineLabel = "Additional action taken";
    photoKeys = parsedPhotos;
  } else {
    return jsonResponse(400, { error: "Unsupported update type" });
  }

  const update = {
    ...taskUpdateKey(siteId, taskId, now, updateId),
    entityType: "task_update",
    taskId,
    updateId,
    type,
    label: timelineLabel,
    occurredAt: now,
    actorId: actorId(event),
    documentationState,
    ...(period ? { presencePeriod: period } : {}),
    ...(text ? { text } : {}),
    ...(notes.length ? { notes } : {}),
    ...(photoKeys.length ? { photoKeys } : {}),
  };
  const status = resolved ? "completed" : "in_progress";
  const updated = {
    ...task,
    status,
    latestUpdateId: updateId,
    latestUpdateLabel: label,
    updatedAt: now,
    ...(period ? { lastAnsweredPresencePeriod: period } : {}),
    ...(resolved
      ? {
          resolvedAt: now,
          completedAt: now,
          completionMethod: "site_team_resolved",
        }
      : {}),
    ...taskWorklistDateGsi(
      siteId,
      status,
      String(task.kind || ""),
      Number(task.severity || 0),
      now,
      taskId,
    ),
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: dynamoTable,
              Item: update,
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: updated,
              ConditionExpression:
                "#status = :inProgress AND updatedAt = :prior",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":inProgress": "in_progress",
                ":prior": task.updatedAt,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException")
      return jsonResponse(409, { error: "Task update conflict" });
    throw error;
  }
  return jsonResponse(201, { task: detail(updated, [update]).task, update });
};

/** POST /v1/tasks/{taskId}/updates/{updateId}/document */
export const documentTaskUpdate = async (event) => {
  const input = bodyOf(event);
  if (!input) return jsonResponse(400, { error: "Invalid JSON body" });
  const notes = textList(input.notes || [], MAX_NOTES);
  const photoKeys = photoList(input.photoKeys || []);
  if (!notes || !photoKeys)
    return jsonResponse(400, { error: "Invalid documentation" });
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  const updateId = String(event.pathParameters?.updateId || "");
  const result = await ddb.send(
    new QueryCommand({
      TableName: dynamoTable,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      FilterExpression: "updateId = :updateId",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": taskUpdatePrefix(taskId),
        ":updateId": updateId,
      },
    }),
  );
  const existing = result.Items?.[0];
  if (!existing) return jsonResponse(404, { error: "Update not found" });
  if (existing.actorId !== actorId(event))
    return jsonResponse(403, { error: "Update belongs to another session" });
  if (existing.documentationState === "closed")
    return jsonResponse(200, { update: existing });
  if (existing.documentationState !== "open_for_documentation")
    return jsonResponse(409, { error: "Update cannot be documented" });
  const updated = {
    ...existing,
    notes,
    photoKeys,
    documentationState: "closed",
    documentedAt: new Date().toISOString(),
  };
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: dynamoTable,
            Item: updated,
            ConditionExpression: "documentationState = :open",
            ExpressionAttributeValues: { ":open": "open_for_documentation" },
          },
        },
      ],
    }),
  );
  return jsonResponse(200, { update: updated });
};

/** POST /v1/tasks/{taskId}/update-media — register an already-uploaded photo without analysis. */
export const registerTaskUpdateMedia = async (event) => {
  const input = bodyOf(event);
  if (!input) return jsonResponse(400, { error: "Invalid JSON body" });
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  const task = await getTask(dynamoTable, siteId, taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  if (!["in_progress", "completed"].includes(task.status))
    return jsonResponse(409, { error: "Task cannot accept update media" });
  const artifactId = String(input.artifactId || "");
  const checkId = String(input.checkId || "");
  const s3Key = String(input.s3Key || "");
  const contentType = String(input.contentType || "");
  if (
    !artifactId ||
    !checkId ||
    checkId !== String(task.checkId || "") ||
    !s3Key.startsWith(`checks/${siteId}/${checkId}/`) ||
    !ALLOWED_CONTENT_TYPES.has(contentType)
  ) {
    return jsonResponse(400, { error: "Invalid update media" });
  }
  try {
    await ddb.send(
      new PutCommand({
        TableName: dynamoTable,
        Item: {
          ...artifactKey(siteId, checkId, artifactId),
          checkId,
          artifactId,
          s3Key,
          contentType,
          capturedAt:
            typeof input.capturedAt === "string"
              ? input.capturedAt
              : new Date().toISOString(),
          purpose: "task_update",
          taskId,
        },
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    )
      return jsonResponse(200, { artifactId, status: "registered" });
    throw error;
  }
  return jsonResponse(201, { artifactId, status: "registered" });
};
