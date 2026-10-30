import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { taskKey, taskWorklistDateGsi } from "../../handlers/keys.js";
import { sf311FilingJob } from "./sf311-job.js";

/**
 * Queue a "File 311 ticket" tap for the background SF311 job worker.
 *
 * One transaction moves the task to `in_progress` with
 * `appActionStatus: "queued"` and writes an `SF311_OUTBOX` job row; the
 * worker (`workers/sf311-job.js`) makes the HUB calls. No HUB call happens
 * here, so the tap answers right away.
 * - An open task (or one stuck `completing` past its lease) is queued.
 * - A task whose filing failed is queued again with a new job (the retry
 *   button).
 * - A task already queued or filed is returned as-is, so a repeat tap is
 *   harmless instead of a 409.
 * @param {object} opts
 * @param {string} opts.tableName
 * @param {string} opts.siteId
 * @param {string} opts.taskId
 * @param {Record<string, any>} opts.task Consistent read of the task.
 * @param {string} [opts.actorId]
 * @param {any[]} [opts.duplicateChecks]
 * @param {{mode: string, acceptedAt: string, checks: any[]}} [opts.filingDecision]
 * @param {Date} opts.now
 * @returns {Promise<Record<string, unknown>>}
 */
export async function queue311Filing(opts) {
  const { task } = opts;
  const now = opts.now.toISOString();
  const job = sf311FilingJob({
    tableName: opts.tableName,
    siteId: opts.siteId,
    taskId: opts.taskId,
    actorId: opts.actorId ?? "site-team",
    now,
    deliveryMode: opts.filingDecision?.mode ?? task.deliberate311DeliveryMode,
  });
  if (
    task.status === "in_progress" &&
    task.inProgressActionKind === "311_filed"
  ) {
    if (task.appActionStatus !== "failed") return task;
    return requeue(opts, now, job);
  }
  if (
    task.status !== "open" &&
    !(
      task.status === "completing" &&
      isExpired(task.completionLeaseExpiresAt, opts.now)
    )
  ) {
    throw namedError("TerminalConflict", "Task is no longer open");
  }

  const queued = {
    ...task,
    ...(opts.filingDecision
      ? {
          deliberate311DeliveryMode: opts.filingDecision.mode,
          deliberate311AcceptedAt: opts.filingDecision.acceptedAt,
        }
      : {}),
    status: "in_progress",
    appActionStatus: "queued",
    inProgressAt: now,
    inProgressActionKind: "311_filed",
    agency: "311",
    lastAnsweredPresencePeriod: 0,
    completionLeaseExpiresAt: null,
    updatedAt: now,
    ...taskWorklistDateGsi(
      opts.siteId,
      "in_progress",
      String(task.kind),
      Number(task.severity ?? 0),
      now,
      opts.taskId,
    ),
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(opts.duplicateChecks ?? []),
          ...(opts.filingDecision?.checks ?? []),
          {
            Put: {
              TableName: opts.tableName,
              Item: queued,
              ConditionExpression:
                "#status = :open OR (#status = :completing AND (attribute_not_exists(#lease) OR #lease <= :now))",
              ExpressionAttributeNames: {
                "#status": "status",
                "#lease": "completionLeaseExpiresAt",
              },
              ExpressionAttributeValues: {
                ":open": "open",
                ":completing": "completing",
                ":now": now,
              },
            },
          },
          job,
        ],
      }),
    );
  } catch (error) {
    // A concurrent tap queued it first: answer with what it wrote.
    const current = await concurrentlyQueued(opts, error);
    if (current) return current;
    throw error;
  }
  return queued;
}

/**
 * @param {Parameters<typeof queue311Filing>[0]} opts
 * @param {string} now
 * @param {ReturnType<typeof sf311FilingJob>} job
 * @returns {Promise<Record<string, unknown>>}
 */
async function requeue(opts, now, job) {
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(opts.duplicateChecks ?? []),
          ...(opts.filingDecision?.checks ?? []),
          {
            Update: {
              TableName: opts.tableName,
              Key: taskKey(opts.siteId, opts.taskId),
              UpdateExpression:
                "SET appActionStatus = :queued, updatedAt = :now" +
                (opts.filingDecision
                  ? ", deliberate311DeliveryMode = :mode, deliberate311AcceptedAt = :accepted"
                  : ""),
              ConditionExpression:
                "#status = :inProgress AND appActionStatus = :failed",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ...(opts.filingDecision
                  ? {
                      ":mode": opts.filingDecision.mode,
                      ":accepted": opts.filingDecision.acceptedAt,
                    }
                  : {}),
                ":queued": "queued",
                ":failed": "failed",
                ":inProgress": "in_progress",
                ":now": now,
              },
            },
          },
          job,
        ],
      }),
    );
  } catch (error) {
    const current = await concurrentlyQueued(opts, error);
    if (current) return current;
    throw error;
  }
  return {
    ...opts.task,
    ...(opts.filingDecision
      ? {
          deliberate311DeliveryMode: opts.filingDecision.mode,
          deliberate311AcceptedAt: opts.filingDecision.acceptedAt,
        }
      : {}),
    appActionStatus: "queued",
    updatedAt: now,
  };
}

/**
 * After a lost race, re-read the task; if another tap queued it, return it.
 * @param {Parameters<typeof queue311Filing>[0]} opts
 * @param {unknown} error
 * @returns {Promise<Record<string, any> | null>}
 */
async function concurrentlyQueued(opts, error) {
  if (
    !(error instanceof Error) ||
    ![
      "TransactionCanceledException",
      "ConditionalCheckFailedException",
    ].includes(error.name)
  ) {
    return null;
  }
  const current = await ddb.send(
    new GetCommand({
      TableName: opts.tableName,
      Key: taskKey(opts.siteId, opts.taskId),
      ConsistentRead: true,
    }),
  );
  const item = current.Item;
  return item?.status === "in_progress" &&
    item.inProgressActionKind === "311_filed" &&
    item.appActionStatus !== "failed"
    ? item
    : null;
}

/**
 * @param {unknown} value
 * @param {Date} now
 * @returns {boolean}
 */
function isExpired(value, now) {
  return typeof value !== "string" || Date.parse(value) <= now.getTime();
}

/**
 * @param {string} name
 * @param {string} message
 * @returns {Error}
 */
function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}
