import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import {
  eligibleTicketsForClosure,
  executeAppActions,
  is311SubmissionEnabled,
  summarizeAppActionResults,
} from "../analysis/guidance/app-actions.js";
import {
  buildTaskUpdateTransition,
  presencePeriod,
  presencePromptDue,
  responseExpectedAt,
} from "../domain/task-updates.js";
import {
  readCheckHeader,
  readLegacyUpdateById,
  readTask,
  readTimeline,
  readUpdateById,
  readUpdatePointer,
  writeDocumentedUpdate,
  writeTaskTransition,
  writeTaskUpdateMedia,
} from "../task-updates/task-update-store.js";

const MAX_PHOTOS = 6;
const MAX_NOTES = 3;
const MAX_TEXT = 4000;
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** @param {any} event @returns {Record<string, any> | null} */
function bodyOf(event) {
  try {
    const value = readJsonBody(event);
    return value && typeof value === "object" ? value : {};
  } catch {
    return null;
  }
}

/** @param {any} event */
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

/** @param {any} event */
function actorId(event) {
  const authorizer = event.requestContext?.authorizer || {};
  return String(
    authorizer.lambda?.["claims.sub"] ||
      authorizer["claims.sub"] ||
      authorizer.jwt?.claims?.sub ||
      "site-team",
  );
}

/** @param {unknown} value @param {number} max @returns {string[] | null} */
function textList(value, max) {
  if (!Array.isArray(value) || value.length > max) return null;
  const values = value.map((item) => String(item || "").trim());
  return values.every((item) => item && item.length <= MAX_TEXT)
    ? values
    : null;
}

/** @param {unknown} value @returns {string[] | null} */
function photoList(value) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) return null;
  const values = value.map((item) => String(item || "").trim());
  return values.every((item) => item && item.length <= 512) ? values : null;
}

/** @param {Record<string, any>} task @param {Record<string, any>[]} updates */
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

/** GET /v1/tasks/{taskId}/updates @param {any} event */
export const getTaskUpdates = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  if (!taskId) return jsonResponse(400, { error: "Missing taskId" });
  const [task, timelinePage] = await Promise.all([
    readTask(dynamoTable, siteId, taskId),
    readTimeline(dynamoTable, siteId, taskId, {
      cursor: String(event.queryStringParameters?.nextToken || ""),
    }),
  ]);
  if (!timelinePage) return jsonResponse(400, { error: "Invalid nextToken" });
  if (!task) return jsonResponse(404, { error: "Task not found" });
  const check = await readCheckHeader(
    dynamoTable,
    siteId,
    String(task.checkId || ""),
  );
  return jsonResponse(200, {
    ...detail(task, timelinePage.items),
    nextToken: timelinePage.nextToken,
    issueOrigin:
      check?.flowType === "single-problem" ? "single-problem" : "perimeter",
  });
};

/** POST /v1/tasks/{taskId}/updates @param {any} event */
export const createTaskUpdate = async (event) => {
  const input = bodyOf(event);
  if (!input) return jsonResponse(400, { error: "Invalid JSON body" });
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  const task = await readTask(dynamoTable, siteId, taskId);
  if (!task) return jsonResponse(404, { error: "Task not found" });
  const updateId = idempotencyId(event);
  const priorUpdate = await readUpdatePointer(
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
  if (task.status !== "in_progress") {
    const legacyRetry = await readLegacyUpdateById(
      dynamoTable,
      siteId,
      taskId,
      updateId,
    );
    if (legacyRetry)
      return jsonResponse(200, {
        task: detail(task, [legacyRetry]).task,
        update: legacyRetry,
      });
    return jsonResponse(409, { error: "Task is not in progress" });
  }

  const transition = buildTaskUpdateTransition(task, input, {
    taskId,
    updateId,
    actorId: actorId(event),
  });
  if ("error" in transition)
    return jsonResponse(transition.statusCode, { error: transition.error });
  const { update, task: updated } = transition;
  const now = update.occurredAt;
  if (updated.status === "completed" && is311SubmissionEnabled(process.env)) {
    const priorResults = Array.isArray(task.appActionResults)
      ? task.appActionResults
      : [];
    if (eligibleTicketsForClosure(priorResults).size > 0) {
      const closureResults = await executeAppActions(
        [{ code: "close_311_ticket", payload: {} }],
        {
          env: process.env,
          now: new Date(now),
          taskId,
          tableName: dynamoTable,
          siteId,
          task: updated,
          priorResults,
          trigger: "user_confirmed",
        },
      );
      updated.appActionResults = [...priorResults, ...closureResults];
      updated.appActionStatus = summarizeAppActionResults(
        updated.appActionResults,
      );
    }
  }
  try {
    await writeTaskTransition({
      tableName: dynamoTable,
      siteId,
      taskId,
      occurredAt: now,
      update,
      task: updated,
      expectedStatus: "in_progress",
      expectedUpdatedAt: task.updatedAt,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      const legacyRetry = await readLegacyUpdateById(
        dynamoTable,
        siteId,
        taskId,
        updateId,
      );
      if (legacyRetry)
        return jsonResponse(200, {
          task: detail(task, [legacyRetry]).task,
          update: legacyRetry,
        });
      return jsonResponse(409, { error: "Task update conflict" });
    }
    throw error;
  }
  return jsonResponse(201, { task: detail(updated, [update]).task, update });
};

/** POST /v1/tasks/{taskId}/updates/{updateId}/document @param {any} event */
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
  const existing = await readUpdateById(dynamoTable, siteId, taskId, updateId);
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
  await writeDocumentedUpdate(dynamoTable, updated);
  return jsonResponse(200, { update: updated });
};

/** POST /v1/tasks/{taskId}/update-media @param {any} event */
export const registerTaskUpdateMedia = async (event) => {
  const input = bodyOf(event);
  if (!input) return jsonResponse(400, { error: "Invalid JSON body" });
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const taskId = String(event.pathParameters?.taskId || "");
  const task = await readTask(dynamoTable, siteId, taskId);
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
  )
    return jsonResponse(400, { error: "Invalid update media" });
  try {
    await writeTaskUpdateMedia({
      tableName: dynamoTable,
      siteId,
      checkId,
      taskId,
      artifactId,
      s3Key,
      contentType,
      capturedAt:
        typeof input.capturedAt === "string"
          ? input.capturedAt
          : new Date().toISOString(),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "ConditionalCheckFailedException",
        "TransactionCanceledException",
      ].includes(error.name)
    )
      return jsonResponse(200, { artifactId, status: "registered" });
    throw error;
  }
  return jsonResponse(201, { artifactId, status: "registered" });
};
