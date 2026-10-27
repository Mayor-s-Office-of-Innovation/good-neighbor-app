import { randomUUID } from "node:crypto";
import {
  is311SubmissionEnabled,
  eligibleTicketsForClosure,
} from "./app-actions.js";

/** Commit background work in the same transaction as the task, never after it.
 * @param {string} tableName
 * @param {string} siteId
 * @param {Record<string, any>} task
 * @param {string} phase
 * @param {Record<string, string | undefined>} [env]
 * @returns {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>}
 */
export function sf311Job(tableName, siteId, task, phase, env = process.env) {
  if (!is311SubmissionEnabled(env)) return [];
  const automatic = /** @type {import("./app-actions.js").AppAction[]} */ (
    task.appActions || []
  ).some(
    (action) =>
      action.code === "create_311_ticket" &&
      action.payload?.executionTrigger === "task_created",
  );
  if (
    !automatic &&
    !(
      phase !== "created" &&
      eligibleTicketsForClosure(task.appActionResults || []).size
    )
  )
    return [];
  return [
    {
      Put: {
        TableName: tableName,
        Item: {
          pk: `SITE#${siteId}`,
          sk: `SF311_JOB#${task.taskId}#${phase}`,
          entityType: "SF311_OUTBOX",
          status: "pending",
          siteId,
          taskId: task.taskId,
          createdAt: task.updatedAt || task.createdAt,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    },
  ];
}

/**
 * Job row for a "File 311 ticket" tap. Unlike the silent jobs above, it runs
 * the task's user-confirmed actions and records the outcome on the task. Each
 * tap (or retry tap) gets its own phase, so a retry is a fresh INSERT the
 * stream dispatcher picks up.
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.taskId
 * @param {string} opts.actorId
 * @param {string} opts.now
 * @returns {NonNullable<import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]>[number]}
 */
export function sf311FilingJob({ tableName, siteId, taskId, actorId, now }) {
  return {
    Put: {
      TableName: tableName,
      Item: {
        pk: `SITE#${siteId}`,
        sk: `SF311_JOB#${taskId}#filed-${randomUUID()}`,
        entityType: "SF311_OUTBOX",
        status: "pending",
        siteId,
        taskId,
        trigger: "user_confirmed",
        actorId,
        createdAt: now,
      },
      ConditionExpression: "attribute_not_exists(pk)",
    },
  };
}
