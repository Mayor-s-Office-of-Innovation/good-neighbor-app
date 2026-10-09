import {
  cityHelpTicket,
  prepareCityHelpNote,
  deliverCityHelpNote,
} from "../task-updates/city-help-note.js";
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import { headObject, setObjectTags } from "../s3.js";
import {
  eligibleTicketsForClosure,
  executeAppActions,
  is311SubmissionEnabled,
  mergeAppActionResults,
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
  claimTaskResolution,
  readLegacyUpdateById,
  readTask,
  readTaskUpdateMediaRegistration,
  readTimeline,
  readUpdateById,
  readUpdatePointer,
  releaseTaskResolution,
  writeDocumentedUpdate,
  writeTaskTransition,
  writeTaskUpdateMedia,
} from "../task-updates/task-update-store.js";

const MAX_PHOTOS = 6;
const MAX_NOTES = 3;
const MAX_TEXT = 4000;
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const RESOLUTION_LEASE_MS = 5 * 60 * 1000;
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
  if (priorUpdate) {
    if (!(await deliverCityHelpNote(dynamoTable, siteId, priorUpdate)))
      return jsonResponse(502, {
        error: "City update not confirmed",
        updateSaved: true,
        retryable: true,
      });
    return jsonResponse(200, {
      task: detail(task, [priorUpdate]).task,
      update: priorUpdate,
    });
  }
  const resolutionLeaseExpired =
    task.status === "resolving" &&
    new Date(String(task.resolutionLeaseExpiresAt ?? "")).getTime() <=
      Date.now();
  if (task.status !== "in_progress" && !resolutionLeaseExpired) {
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

  const srNum = cityHelpTicket(task);
  const informational = ["note_photo_update", "additional_action"].includes(
    input.type,
  );
  if (informational && srNum && typeof input.cityHelpNeeded !== "boolean")
    return jsonResponse(400, {
      error: "Choose whether City help is still needed",
    });
  if (input.cityHelpNeeded !== undefined && (!informational || !srNum))
    return jsonResponse(400, {
      error: "City help choice requires a filed 311 request",
    });
  if (input.cityHelpNeeded === false && !is311SubmissionEnabled(process.env))
    return jsonResponse(503, { error: "City updates are unavailable" });

  const transition = buildTaskUpdateTransition(task, input, {
    taskId,
    updateId,
    actorId: deriveActorId(event),
  });
  if ("error" in transition)
    return jsonResponse(transition.statusCode, { error: transition.error });
  const { update, task: updated } = transition;
  const now = update.occurredAt;
  if (informational && srNum) {
    update.cityHelpNeeded = input.cityHelpNeeded;
    if (input.cityHelpNeeded === false) {
      try {
        update.cityNotePayload = await prepareCityHelpNote(
          dynamoTable,
          siteId,
          srNum,
          now,
        );
        update.cityNoteStatus = "pending";
      } catch {
        return jsonResponse(503, { error: "City update cannot be prepared" });
      }
    }
  }
  let resolutionLeaseExpiresAt = "";
  if (updated.status === "completed" && is311SubmissionEnabled(process.env)) {
    let priorResults = Array.isArray(task.appActionResults)
      ? task.appActionResults
      : [];
    if (eligibleTicketsForClosure(priorResults).size > 0) {
      resolutionLeaseExpiresAt = new Date(
        new Date(now).getTime() + RESOLUTION_LEASE_MS,
      ).toISOString();
      let claimed;
      try {
        claimed = await claimTaskResolution({
          tableName: dynamoTable,
          siteId,
          task,
          updateId,
          now,
          leaseExpiresAt: resolutionLeaseExpiresAt,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ConditionalCheckFailedException"
        ) {
          return jsonResponse(409, { error: "Task resolution in progress" });
        }
        throw error;
      }
      priorResults = Array.isArray(claimed?.appActionResults)
        ? claimed.appActionResults
        : priorResults;
      const closureResults = await executeAppActions(
        [{ code: "close_311_ticket", payload: {} }],
        {
          env: process.env,
          now: new Date(now),
          taskId,
          tableName: dynamoTable,
          siteId,
          task: claimed ?? updated,
          priorResults,
          trigger: "user_confirmed",
          executionLease: {
            status: "resolving",
            attribute: "resolutionLeaseExpiresAt",
            value: resolutionLeaseExpiresAt,
          },
          // An expired lease can mean HUB accepted a close before the prior
          // executor persisted its checkpoint. Reconcile remote state before
          // retrying the non-idempotent update.
          reconcile311Closures: resolutionLeaseExpired,
        },
      );
      updated.appActionResults = closureResults.reduce(
        (results, result) => mergeAppActionResults(results, result),
        priorResults,
      );
      updated.appActionStatus = summarizeAppActionResults(
        updated.appActionResults,
      );
      const closureSucceeded = closureResults.every(
        (result) => result.status === "submitted",
      );
      if (!closureSucceeded) {
        let released;
        try {
          released = await releaseTaskResolution({
            tableName: dynamoTable,
            siteId,
            taskId,
            task: claimed ?? task,
            leaseExpiresAt: resolutionLeaseExpiresAt,
            appActionResults: updated.appActionResults,
            appActionStatus: updated.appActionStatus,
            now,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.name === "ConditionalCheckFailedException"
          ) {
            return jsonResponse(409, { error: "Task resolution in progress" });
          }
          throw error;
        }
        return jsonResponse(502, {
          error: "311 ticket closure incomplete",
          retryable: true,
          task: released,
        });
      }
      delete updated.resolutionUpdateId;
      delete updated.resolutionStartedAt;
      delete updated.resolutionLeaseExpiresAt;
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
      expectedStatus: resolutionLeaseExpiresAt ? "resolving" : "in_progress",
      ...(resolutionLeaseExpiresAt
        ? {
            expectedLease: {
              attribute: "resolutionLeaseExpiresAt",
              value: resolutionLeaseExpiresAt,
            },
          }
        : { expectedUpdatedAt: task.updatedAt }),
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
      if (legacyRetry) {
        if (!(await deliverCityHelpNote(dynamoTable, siteId, legacyRetry)))
          return jsonResponse(502, {
            error: "City update not confirmed",
            updateSaved: true,
            retryable: true,
          });
        return jsonResponse(200, {
          task: detail(task, [legacyRetry]).task,
          update: legacyRetry,
        });
      }
      return jsonResponse(409, { error: "Task update conflict" });
    }
    throw error;
  }
  if (!(await deliverCityHelpNote(dynamoTable, siteId, update)))
    return jsonResponse(502, {
      error: "City update not confirmed",
      updateSaved: true,
      retryable: true,
    });
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
  if (existing.actorId !== deriveActorId(event))
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
  const { dynamoTable, uploadBucket } = getConfig();
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
  const contentLength = Number(input.contentLength);
  if (
    !artifactId ||
    !checkId ||
    checkId !== String(task.checkId || "") ||
    s3Key !== `checks/${siteId}/${checkId}/${artifactId}` ||
    !ALLOWED_CONTENT_TYPES.has(contentType) ||
    !Number.isInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_OBJECT_BYTES
  )
    return jsonResponse(400, { error: "Invalid update media" });
  let object;
  try {
    object = await headObject({ bucket: uploadBucket, key: s3Key });
  } catch (error) {
    if (
      error instanceof Error &&
      ["NotFound", "NoSuchKey"].includes(error.name)
    )
      return jsonResponse(409, { error: "media_upload_missing" });
    throw error;
  }
  if (
    object.contentType !== contentType ||
    object.contentLength !== contentLength ||
    object.metadata?.["declared-bytes"] !== String(contentLength)
  ) {
    await setObjectTags({
      bucket: uploadBucket,
      key: s3Key,
      tags: { state: "rejected" },
    });
    return jsonResponse(422, { error: "media_metadata_mismatch" });
  }
  let alreadyRegistered = false;
  try {
    await writeTaskUpdateMedia({
      tableName: dynamoTable,
      siteId,
      checkId,
      taskId,
      artifactId,
      s3Key,
      contentType,
      contentLength,
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
    ) {
      const existing = await readTaskUpdateMediaRegistration({
        tableName: dynamoTable,
        siteId,
        checkId,
        taskId,
        artifactId,
      });
      const media = existing.media;
      const pointer = existing.pointer;
      const exactRetry =
        media?.taskId === taskId &&
        media?.checkId === checkId &&
        media?.artifactId === artifactId &&
        media?.s3Key === s3Key &&
        media?.contentType === contentType &&
        Number(media?.contentLength) === contentLength &&
        pointer?.taskId === taskId &&
        pointer?.checkId === checkId &&
        pointer?.artifactId === artifactId &&
        pointer?.mediaSk === media?.sk;
      if (!exactRetry) {
        return jsonResponse(409, { error: "task_update_media_conflict" });
      }
      alreadyRegistered = true;
    } else {
      throw error;
    }
  }
  await setObjectTags({
    bucket: uploadBucket,
    key: s3Key,
    tags: { state: "accepted" },
  });
  return jsonResponse(alreadyRegistered ? 200 : 201, {
    artifactId,
    status: "registered",
  });
};
