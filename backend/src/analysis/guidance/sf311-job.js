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
