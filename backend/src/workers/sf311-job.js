import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import {
  taskKey,
  taskUpdateKey,
  taskUpdatePointerKey,
  taskUpdateTimelineGsi,
  taskWorklistDateGsi,
} from "../handlers/keys.js";
import { logServerError } from "../lib/log-server-error.js";
import {
  executeAppActions,
  eligibleTicketsForClosure,
  is311SubmissionEnabled,
  mergeAppActionResults,
  summarizeAppActionResults,
} from "../analysis/guidance/app-actions.js";

const sqs = new SQSClient({});
const permanentReasons = new Set([
  "missing_location",
  "insufficient_classifier_information",
  "missing_service_code",
  "no_service_codes",
  "responsible_agency_not_found",
]);
/**
 * A tapped filing gives up on the queue's last delivery, so the task ends
 * `failed` (and the card offers retry) instead of the message reaching the
 * DLQ with the task stuck `queued`. Keep in sync with the submissions
 * queue's `maxReceiveCount` in infra/modules/app/lambda.tf.
 */
const MAX_FILING_ATTEMPTS = 5;

/** @param {string | undefined} receiveCount
 * @param {number} [leaseWaitSeconds]
 */
export function retryDelaySeconds(receiveCount, leaseWaitSeconds = 0) {
  const count = Number(receiveCount);
  const attempt = Number.isSafeInteger(count) && count > 0 ? count : 1;
  const backoff = Math.min(900, 30 * 2 ** Math.min(attempt - 1, 5));
  return Math.min(900, Math.max(backoff, leaseWaitSeconds));
}

/** Keep durable ticket/closure checkpoints even when a later operation fails.
 * @param {import("../analysis/guidance/app-actions.js").AppActionResult[]} prior
 * @param {import("../analysis/guidance/app-actions.js").AppActionResult} result
 */
export function mergeBackgroundResult(prior, result) {
  const previous = prior.find((entry) => entry.code === result.code);
  const payload = { ...previous?.payload, ...result.payload };
  for (const key of ["tickets", "closures"]) {
    const entries = new Map();
    const before = /** @type {Record<string, any>[]} */ (
      previous?.payload?.[key] || []
    );
    const after = /** @type {Record<string, any>[]} */ (
      result.payload?.[key] || []
    );
    for (const entry of [...before, ...after]) {
      const existing = entries.get(entry.serviceCode);
      if (existing?.status === "closed" || (existing?.srNum && !entry.srNum))
        continue;
      entries.set(entry.serviceCode, entry);
    }
    if (entries.size) payload[key] = [...entries.values()];
  }
  return mergeAppActionResults(prior, { ...result, payload });
}

/** @type {import("aws-lambda").SQSHandler} */
export const handler = async (event) => {
  for (const record of event.Records) {
    try {
      await runJob(JSON.parse(record.body), {
        receiveCount: Number(record.attributes?.ApproximateReceiveCount) || 1,
      });
    } catch (error) {
      // The dispatcher invokes us with one record and reports this rejection as
      // a partial batch failure. Never acknowledge a failed visibility update.
      const { queueUrl } = getConfig();
      const leaseWait = /** @type {{retryAfterSeconds?: number}} */ (error)
        ?.retryAfterSeconds;
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: record.receiptHandle,
          VisibilityTimeout: retryDelaySeconds(
            record.attributes.ApproximateReceiveCount,
            leaseWait,
          ),
        }),
      );
      throw error;
    }
  }
};

/**
 * @param {{siteId: string, taskId: string, jobPk: string, jobSk: string}} message
 * @param {{ receiveCount?: number }} [delivery]
 */
export async function runJob(message, delivery = {}) {
  const { dynamoTable: tableName } = getConfig();
  const jobKey = { pk: message.jobPk, sk: message.jobSk };
  if (
    jobKey.pk !== `SITE#${message.siteId}` ||
    !jobKey.sk.startsWith(`SF311_JOB#${message.taskId}#`)
  )
    throw new Error("Invalid SF311 job");
  /** @param {{pk: string, sk: string}} Key */
  const read = async (Key) =>
    (
      await ddb.send(
        new GetCommand({ TableName: tableName, Key, ConsistentRead: true }),
      )
    ).Item;
  const job = await read(jobKey);
  if (!job || ["complete", "failed"].includes(job.status)) return;
  if (!is311SubmissionEnabled())
    throw new Error("SF311 processing is disabled");
  const key = taskKey(message.siteId, message.taskId);
  const lockKey = { pk: jobKey.pk, sk: `SF311_LOCK#${message.taskId}` };
  const token = randomUUID();
  const now = new Date();
  // Longer than the worker's 300-second maximum runtime. Independent of task
  // status so a user's completion can still proceed while City requests run.
  const expires = new Date(now.getTime() + 360_000).toISOString();
  const claimed = await ddb
    .send(
      new UpdateCommand({
        TableName: tableName,
        Key: lockKey,
        UpdateExpression:
          "SET sf311Lease = :token, sf311LeaseExpiresAt = :expires",
        ConditionExpression:
          "attribute_not_exists(sf311Lease) OR sf311LeaseExpiresAt < :now",
        ExpressionAttributeValues: {
          ":token": token,
          ":expires": expires,
          ":now": now.toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(async (error) => {
      if (error?.name === "ConditionalCheckFailedException") {
        const lock = await read(lockKey);
        const remaining = Date.parse(lock?.sf311LeaseExpiresAt) - Date.now();
        if (Number.isFinite(remaining) && remaining > 0)
          error.retryAfterSeconds = Math.ceil(remaining / 1000) + 1;
      }
      throw error;
    });
  let results =
    /** @type {import("../analysis/guidance/app-actions.js").AppActionResult[]} */ ([]);
  /** @param {import("../analysis/guidance/app-actions.js").AppActionResult} result */
  const checkpoint = async (result) => {
    const next = mergeBackgroundResult(results, result);
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: lockKey,
              UpdateExpression: "SET results = :results",
              ConditionExpression: "sf311Lease = :token",
              ExpressionAttributeValues: { ":token": token, ":results": next },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: jobKey,
              UpdateExpression: "SET results = :results",
              ExpressionAttributeValues: { ":results": next },
            },
          },
        ],
      }),
    );
    results = next;
  };
  try {
    let task = await read(key);
    if (!task || task.status === "completing" || task.status === "resolving")
      throw new Error("SF311 task unavailable");
    for (const result of [
      ...(task.appActionResults || []),
      ...(job.results || []),
      ...(claimed.Attributes?.results || []),
    ])
      results = mergeBackgroundResult(results, result);
    if (job.trigger === "user_confirmed") {
      await fileUserConfirmed({
        tableName,
        message,
        jobKey,
        lockKey,
        token,
        job,
        task,
        results,
        checkpoint,
        read,
        attempt: delivery.receiveCount ?? 1,
      });
      return;
    }
    const alreadyFiled = results.some(
      (result) =>
        result.code === "create_311_ticket" && result.status === "submitted",
    );
    if (!["superseded", "deleted"].includes(task.status) && !alreadyFiled) {
      const created = await executeAppActions(task.appActions || [], {
        tableName,
        siteId: message.siteId,
        taskId: message.taskId,
        task,
        priorResults: results,
        trigger: "task_created",
        onCheckpoint: checkpoint,
      });
      for (const result of created) await checkpoint(result);
    }
    // A user may have finished the work while the City filing was underway.
    task = await read(key);
    if (!task || task.status === "completing")
      throw new Error("SF311 task changed; retry after completion");
    if (
      task.status === "completed" &&
      task.completionMethod !== "311_filed" &&
      eligibleTicketsForClosure(results).size
    ) {
      const closed = await executeAppActions(
        [{ code: "close_311_ticket", payload: {} }],
        {
          tableName,
          siteId: message.siteId,
          taskId: message.taskId,
          task,
          priorResults: results,
          onCheckpoint: checkpoint,
          reconcile311Closures: true,
        },
      );
      for (const result of closed) await checkpoint(result);
    }
    // Re-read after remote calls; only merge integration fields, never replace
    // a task whose status/notes were concurrently changed by its user.
    task = await read(key);
    if (!task || task.status === "completing")
      throw new Error("SF311 task changed; retry after completion");
    let merged = task.appActionResults || [];
    for (const result of results)
      merged = mergeBackgroundResult(merged, result);
    const failures = results.filter((result) =>
      ["failed", "partial"].includes(result.status),
    );
    // Only definitive validation failures are terminal. Partial/uncertain City
    // outcomes retain their checkpoints and continue through retry/reconciliation.
    const terminal =
      failures.length > 0 &&
      failures.every(
        (result) =>
          result.status === "failed" &&
          permanentReasons.has(result.reason || ""),
      );
    const retry = failures.length > 0 && !terminal;
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: lockKey,
              ConditionExpression: "sf311Lease = :token",
              ExpressionAttributeValues: { ":token": token },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: key,
              UpdateExpression:
                "SET appActionResults = :results, appActionStatus = :actionStatus",
              ConditionExpression:
                "#status = :status AND " +
                (task.appActionResults
                  ? "appActionResults = :prior"
                  : "attribute_not_exists(appActionResults)"),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": task.status,
                ":results": merged,
                ":actionStatus": summarizeAppActionResults(merged),
                ...(task.appActionResults
                  ? { ":prior": task.appActionResults }
                  : {}),
              },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: jobKey,
              UpdateExpression: "SET #status = :status, results = :results",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": terminal ? "failed" : retry ? "retry" : "complete",
                ":results": results,
              },
            },
          },
        ],
      }),
    );
    if (retry)
      throw new Error("SF311 action failed; retry from durable checkpoint");
  } finally {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: lockKey,
          UpdateExpression: "REMOVE sf311Lease, sf311LeaseExpiresAt",
          ConditionExpression: "sf311Lease = :token",
          ExpressionAttributeValues: { ":token": token },
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        console.error("SF311 lease release failed; lease will expire", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
    }
  }
}

/**
 * A "File 311 ticket" tap queued by `analysis/guidance/sf311-filing-queue.js`.
 * Runs the task's user-confirmed actions, then records the outcome on the
 * task the way the old in-request path did:
 * - filed: timeline entry, and tasks that cannot be in progress complete
 *   with `completionMethod: "311_filed"`;
 * - retryable failure: back to `queued`, and the throw makes the handler
 *   back off and let SQS redeliver;
 * - permanent failure or last try: `failed`. The task stays `in_progress` so
 *   the card can offer a retry tap, which queues a new job.
 * @param {object} ctx
 * @param {string} ctx.tableName
 * @param {{siteId: string, taskId: string}} ctx.message
 * @param {{pk: string, sk: string}} ctx.jobKey
 * @param {{pk: string, sk: string}} ctx.lockKey
 * @param {string} ctx.token
 * @param {Record<string, any>} ctx.job
 * @param {Record<string, any>} ctx.task
 * @param {import("../analysis/guidance/app-actions.js").AppActionResult[]} ctx.results
 * @param {(result: import("../analysis/guidance/app-actions.js").AppActionResult) => Promise<void>} ctx.checkpoint
 * @param {(key: {pk: string, sk: string}) => Promise<Record<string, any> | undefined>} ctx.read
 * @param {number} ctx.attempt
 * @returns {Promise<void>}
 */
async function fileUserConfirmed(ctx) {
  const { tableName, message, jobKey, task } = ctx;
  const { siteId, taskId } = message;
  const key = taskKey(siteId, taskId);
  /** @param {Record<string, any> | undefined} item */
  const waiting = (item) =>
    item?.status === "in_progress" &&
    item.inProgressActionKind === "311_filed" &&
    item.appActionStatus === "queued";
  /** @param {string} status */
  const finishJob = (status) =>
    ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: jobKey,
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status },
      }),
    );
  // The task moved on (resolved, or filed by an earlier job): nothing to do.
  if (!waiting(task)) return void (await finishJob("abandoned"));

  const executed = await executeAppActions(task.appActions || [], {
    tableName,
    siteId,
    taskId,
    task,
    priorResults: ctx.results,
    trigger: "user_confirmed",
    onCheckpoint: ctx.checkpoint,
  });
  for (const result of executed) await ctx.checkpoint(result);
  const filing = executed.find((result) => result.code === "create_311_ticket");
  const filed = filing?.status === "submitted";
  const retry =
    !filed &&
    filing?.status === "failed" &&
    !permanentReasons.has(filing.reason || "") &&
    // A City outcome we can't confirm needs an operator, not another try.
    !(filing.reason || "").endsWith("_requires_reconciliation") &&
    ctx.attempt < MAX_FILING_ATTEMPTS;

  // Re-read after the remote calls; the checkpoints above keep any filed
  // ticket even if the task changed meanwhile.
  const current = await ctx.read(key);
  if (!waiting(current)) return void (await finishJob("abandoned"));
  let merged = current?.appActionResults || [];
  for (const result of executed) merged = mergeBackgroundResult(merged, result);

  const now = new Date().toISOString();
  const updateId = randomUUID();
  const completes = filed && current?.canBeInProgress !== true;
  /** @type {Record<string, unknown>} */
  const set = {
    appActionResults: merged,
    appActionStatus: filed
      ? summarizeAppActionResults(merged)
      : retry
        ? "queued"
        : "failed",
    updatedAt: now,
    ...(filed
      ? {
          notifiedAt: now,
          latestUpdateId: updateId,
          latestUpdateLabel: "311 ticket filed",
        }
      : {}),
    ...(completes
      ? {
          status: "completed",
          completedAt: now,
          resolvedAt: now,
          completionMethod: "311_filed",
          ...taskWorklistDateGsi(
            siteId,
            "completed",
            String(current?.kind),
            Number(current?.severity ?? 0),
            now,
            taskId,
          ),
        }
      : {}),
  };
  /** @type {Record<string, string>} */
  const names = { "#status": "status" };
  /** @type {Record<string, unknown>} */
  const values = {
    ":inProgress": "in_progress",
    ":queued": "queued",
    ...(current?.appActionResults
      ? { ":prior": current.appActionResults }
      : {}),
  };
  const assignments = Object.entries(set).map(([attribute, value], index) => {
    names[`#a${index}`] = attribute;
    values[`:a${index}`] = value;
    return `#a${index} = :a${index}`;
  });
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: tableName,
            Key: ctx.lockKey,
            ConditionExpression: "sf311Lease = :token",
            ExpressionAttributeValues: { ":token": ctx.token },
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: key,
            UpdateExpression: `SET ${assignments.join(", ")}`,
            ConditionExpression:
              "#status = :inProgress AND appActionStatus = :queued AND " +
              (current?.appActionResults
                ? "appActionResults = :prior"
                : "attribute_not_exists(appActionResults)"),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        },
        {
          Update: {
            TableName: tableName,
            Key: jobKey,
            UpdateExpression: "SET #status = :status, results = :results",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":status": filed ? "complete" : retry ? "retry" : "failed",
              ":results": executed,
            },
          },
        },
        ...(filed
          ? [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...taskUpdateKey(siteId, taskId, now, updateId),
                    ...taskUpdateTimelineGsi(siteId, now, updateId),
                    entityType: "task_update",
                    taskId,
                    updateId,
                    type: "311_ticket_filed",
                    label: "311 ticket filed",
                    occurredAt: now,
                    actorId: String(ctx.job.actorId ?? "site-team"),
                    documentationState:
                      current?.canBeInProgress === false
                        ? "open_for_documentation"
                        : "closed",
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...taskUpdatePointerKey(siteId, taskId, updateId),
                    entityType: "task_update_pointer",
                    taskId,
                    updateId,
                    updateSk: taskUpdateKey(siteId, taskId, now, updateId).sk,
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ]
          : []),
      ],
    }),
  );
  if (retry) throw new Error("SF311 filing failed; retry from checkpoint");
  if (!filed) {
    logServerError(
      "task app-action create_311_ticket",
      new Error(String(filing?.reason ?? "app action failed")),
      {
        extra: {
          eventType: "311_app_action_failed",
          taskId,
          siteId,
          ruleId: String(current?.ruleId ?? ""),
          trigger: "user_confirmed",
          completionMethod: "311_filed",
          attempt: ctx.attempt,
        },
      },
    );
  }
}
