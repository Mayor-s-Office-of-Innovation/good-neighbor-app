import { visibleDuplicateState } from "../analysis/duplicates/result-state.js";
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { deriveActorId, deriveSiteId } from "../lib/principal.js";
import { jsonResponse, readJsonBody } from "../http.js";
import {
  taskKey,
  taskUpdateKey,
  taskUpdateTimelineGsi,
  taskWorklistDateGsi,
  taskTimelineGsi,
} from "./keys.js";
import {
  duplicateForTask,
  overrideKey,
  siteReader,
} from "../analysis/duplicates/links.js";

/** @param {any} event */
export const getDuplicateLinks = async (event) => {
  /** @type {any} */ let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }
  if (
    !Array.isArray(body?.taskIds) ||
    body.taskIds.length > 50 ||
    body.taskIds.some(
      (/** @type {any} */ id) =>
        typeof id !== "string" || !id || id.length > 160,
    )
  )
    return jsonResponse(400, { error: "Specify up to 50 task IDs" });
  const { dynamoTable } = getConfig(),
    site = deriveSiteId(event),
    base = siteReader(dynamoTable, site);
  /** @type {Map<string,ReturnType<typeof base>>} */ const reads = new Map();
  /** @param {{pk:string,sk:string}} key */
  const get = (key) => {
    const id = key.pk + "|" + key.sk;
    if (!reads.has(id)) reads.set(id, base(key));
    return /** @type {ReturnType<typeof base>} */ (reads.get(id));
  };
  const issues = [];
  // Bound database fanout independently of normal analysis.
  for (let i = 0; i < body.taskIds.length; i += 4)
    issues.push(
      ...(await Promise.all(
        body.taskIds
          .slice(i, i + 4)
          .map(async (/** @type {string} */ taskId) => {
            if (
              process.env.DUPLICATE_DETECTION_ENABLED !== "true" &&
              !(await get({ pk: `SITE#${site}`, sk: `DUP_LINK#${taskId}` }))
            )
              return { taskId, state: "disabled" };
            const task = await get(taskKey(site, taskId));
            if (!task) return { taskId, state: "not_found" };
            const relation = await duplicateForTask(
              dynamoTable,
              site,
              task,
              get,
            );
            return {
              taskId,
              state: visibleDuplicateState(
                relation.state,
                relation.pendingSince,
              ),
              ...(relation.state === "matched"
                ? {
                    original: relation.original,
                    sourceRevision: relation.sourceRevision,
                    detectedAt: relation.detectedAt,
                    generatedAt: relation.generatedAt,
                  }
                : {}),
            };
          }),
      )),
    );
  return jsonResponse(200, {
    enabled:
      process.env.DUPLICATE_DETECTION_ENABLED === "true" ||
      issues.some((row) => row.state !== "disabled"),
    issues,
  });
};

/** A durable human override; never deletes evidence or reverses the group's action.
 * @param {any} event
 */
export const separateDuplicate = async (event) => {
  const { dynamoTable } = getConfig(),
    site = deriveSiteId(event),
    get = siteReader(dynamoTable, site);
  const id = event.pathParameters?.taskId;
  if (!id) return jsonResponse(400, { error: "Missing task ID" });
  const task = await get(taskKey(site, id));
  if (!task) return jsonResponse(404, { error: "Task not found" });
  const key = overrideKey(site, task);
  const previousOverride = await get(key);
  if (previousOverride) {
    const restoredId = previousOverride.restoredTaskId ?? id;
    return jsonResponse(200, {
      taskId: restoredId,
      state: "separated",
      task: await get(taskKey(site, restoredId)),
    });
  }
  const relation = await duplicateForTask(dynamoTable, site, task, get);
  if (relation.state !== "matched")
    return jsonResponse(409, { error: "Duplicate link changed" });
  let expected;
  try {
    expected = /** @type {any} */ (readJsonBody(event));
  } catch {
    return jsonResponse(400, { error: "Invalid JSON" });
  }
  if (
    expected?.sourceRevision !== relation.sourceRevision ||
    expected?.originalTaskId !== relation.original.taskId
  )
    return jsonResponse(409, {
      error: "Duplicate link changed; refresh and try again",
    });
  const root = relation.original;
  if (
    ["completing", "resolving"].includes(root.status) ||
    ["completing", "resolving"].includes(task.status)
  )
    return jsonResponse(409, { error: "Action is being saved; try again" });
  const occurredAt = new Date().toISOString(),
    updateId = `separate-${id}`;
  const restore = task.status !== "open";
  const restoredId = restore ? randomUUID() : id;
  const pointer = restore
    ? await get({
        pk: `SITE#${site}`,
        sk: `GUIDANCE_CURRENT#${JSON.stringify([task.checkId, task.sourceArtifactIds[0]])}`,
      })
    : null;
  const condition = pointer
    ? await get({
        pk: `SITE#${site}`,
        sk: `ASSESSMENT#${pointer.assessmentId}#COND#${task.conditionId}`,
      })
    : null;
  if (restore && !condition?.taskIds?.includes(id))
    return jsonResponse(409, { error: "Issue changed; refresh and try again" });
  /** @type {Record<string,any>} */ const restored = {
    ...task,
    ...taskKey(site, restoredId),
    taskId: restoredId,
    status: "open",
    restoredFromTaskId: id,
    updatedAt: occurredAt,
    appActionResults: [],
    appActionStatus: "not_started",
    ...taskWorklistDateGsi(
      site,
      "open",
      task.kind,
      task.severity,
      occurredAt,
      restoredId,
    ),
    ...taskTimelineGsi(site, task.createdAt, restoredId),
  };
  for (const field of [
    "completedAt",
    "completionMethod",
    "inProgressAt",
    "notifiedAt",
    "agency",
    "inProgressActionKind",
    "latestUpdateId",
    "latestUpdateLabel",
    "lastAnsweredPresencePeriod",
    "resolvedAt",
    "cannotDo",
    "completionStartedAt",
    "completionLeaseExpiresAt",
  ])
    delete restored[field];
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(restore
            ? [
                {
                  Put: {
                    TableName: dynamoTable,
                    Item: restored,
                    ConditionExpression: "attribute_not_exists(sk)",
                  },
                },
                {
                  Put: {
                    TableName: dynamoTable,
                    Item: {
                      ...task,
                      status: "superseded",
                      supersededByTaskId: restoredId,
                      ...taskWorklistDateGsi(
                        site,
                        "superseded",
                        task.kind,
                        task.severity,
                        occurredAt,
                        id,
                      ),
                    },
                    ConditionExpression:
                      "#status = :status AND updatedAt = :updated",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":status": task.status,
                      ":updated": task.updatedAt,
                    },
                  },
                },
                {
                  Put: {
                    TableName: dynamoTable,
                    Item: {
                      ...condition,
                      taskIds: condition?.taskIds.map(
                        (/** @type {string} */ t) =>
                          t === id ? restoredId : t,
                      ),
                    },
                    ConditionExpression: "taskIds = :previous",
                    ExpressionAttributeValues: {
                      ":previous": condition?.taskIds,
                    },
                  },
                },
              ]
            : []),
          {
            ConditionCheck: {
              TableName: dynamoTable,
              Key: relation.analysisKey,
              ConditionExpression: "analysisId = :id AND concerns = :concerns",
              ExpressionAttributeValues: {
                ":id": relation.analysis.analysisId,
                ":concerns": relation.analysis.concerns,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: dynamoTable,
              Key: taskKey(site, root.taskId),
              ConditionExpression: "#status = :status AND updatedAt = :updated",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": root.status,
                ":updated": root.updatedAt,
              },
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: {
                ...key,
                taskId: id,
                restoredTaskId: restoredId,
                originalTaskId: root.taskId,
                sourceRevision: relation.sourceRevision,
                actorId: deriveActorId(event),
                occurredAt,
              },
              ConditionExpression: "attribute_not_exists(sk)",
            },
          },
          {
            Put: {
              TableName: dynamoTable,
              Item: {
                ...taskUpdateKey(site, root.taskId, occurredAt, updateId),
                ...taskUpdateTimelineGsi(site, occurredAt, updateId),
                entityType: "task_update",
                taskId: root.taskId,
                updateId,
                type: "duplicate_separated",
                sourceTaskId: id,
                occurredAt,
                actorId: deriveActorId(event),
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.name !== "TransactionCanceledException"
    )
      throw error;
    const winner = await get(key);
    if (!winner)
      return jsonResponse(409, {
        error: "Issue changed; refresh and try again",
      });
    const winnerId = winner.restoredTaskId ?? id;
    return jsonResponse(200, {
      taskId: winnerId,
      state: "separated",
      task: await get(taskKey(site, winnerId)),
    });
  }
  return jsonResponse(200, {
    taskId: restoredId,
    state: "separated",
    task: restore ? restored : task,
  });
};
