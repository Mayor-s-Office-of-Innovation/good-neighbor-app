import { randomUUID } from "node:crypto";
import {
  GetCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { taskKey } from "../handlers/keys.js";
import {
  executeAppActions,
  eligibleTicketsForClosure,
  is311SubmissionEnabled,
  mergeAppActionResults,
  summarizeAppActionResults,
} from "../analysis/guidance/app-actions.js";

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
  for (const record of event.Records) await runJob(JSON.parse(record.body));
};

/** @param {{siteId: string, taskId: string, jobPk: string, jobSk: string}} message */
export async function runJob(message) {
  const { dynamoTable: tableName } = getConfig();
  const jobKey = { pk: message.jobPk, sk: message.jobSk };
  if (
    jobKey.pk !== `SITE#${message.siteId}` ||
    !jobKey.sk.startsWith(`AUTO311_JOB#${message.taskId}#`)
  )
    throw new Error("Invalid automatic 311 job");
  /** @param {{pk: string, sk: string}} Key */
  const read = async (Key) =>
    (
      await ddb.send(
        new GetCommand({ TableName: tableName, Key, ConsistentRead: true }),
      )
    ).Item;
  const job = await read(jobKey);
  if (!job || job.status === "complete") return;
  if (!is311SubmissionEnabled())
    throw new Error("Automatic 311 processing is disabled");
  const key = taskKey(message.siteId, message.taskId);
  const lockKey = { pk: jobKey.pk, sk: `AUTO311_LOCK#${message.taskId}` };
  const token = randomUUID();
  const now = new Date();
  // Longer than the worker's 300-second maximum runtime. Independent of task
  // status so a user's completion can still proceed while City requests run.
  const expires = new Date(now.getTime() + 360_000).toISOString();
  const claimed = await ddb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: lockKey,
      UpdateExpression:
        "SET auto311Lease = :token, auto311LeaseExpiresAt = :expires",
      ConditionExpression:
        "attribute_not_exists(auto311Lease) OR auto311LeaseExpiresAt < :now",
      ExpressionAttributeValues: {
        ":token": token,
        ":expires": expires,
        ":now": now.toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
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
              ConditionExpression: "auto311Lease = :token",
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
      throw new Error("Automatic 311 task unavailable");
    for (const result of [
      ...(task.appActionResults || []),
      ...(job.results || []),
      ...(claimed.Attributes?.results || []),
    ])
      results = mergeBackgroundResult(results, result);
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
      throw new Error("Automatic 311 task changed; retry after completion");
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
      throw new Error("Automatic 311 task changed; retry after completion");
    let merged = task.appActionResults || [];
    for (const result of results)
      merged = mergeBackgroundResult(merged, result);
    const failed = results.some((result) =>
      ["failed", "partial"].includes(result.status),
    );
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName,
              Key: lockKey,
              ConditionExpression: "auto311Lease = :token",
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
                ":status": failed ? "retry" : "complete",
                ":results": results,
              },
            },
          },
        ],
      }),
    );
    if (failed)
      throw new Error(
        "Automatic 311 action failed; retry from durable checkpoint",
      );
  } finally {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: lockKey,
          UpdateExpression: "REMOVE auto311Lease, auto311LeaseExpiresAt",
          ConditionExpression: "auto311Lease = :token",
          ExpressionAttributeValues: { ":token": token },
        }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        console.error("Automatic 311 lease release failed; lease will expire", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
    }
  }
}
