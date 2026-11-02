import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { taskKey, taskWorklistDateGsi } from "../../handlers/keys.js";
import { conditionDeletionKey } from "../guidance/guidance-store.js";
import { groupForTask, readTask } from "./group.js";

/** @param {string} message */
function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/** The confirmation and the write use exactly the same server-owned scope.
 * @param {string} table @param {string} siteId @param {Record<string, any>} clicked
 * @param {Awaited<ReturnType<typeof groupForTask>>} [knownGroup]
 */
export async function deletionScope(table, siteId, clicked, knownGroup) {
  const group = knownGroup || (await groupForTask(table, siteId, clicked));
  const duplicate = group.rootTaskId !== clicked.taskId;
  const members = (duplicate ? [clicked] : group.tasks).filter(
    (task) => task.status !== "superseded",
  );
  if (!members.length)
    throw conflict("Card was already deleted; refresh and retry");
  const targets = members.map((task) => {
    const artifactId = task.sourceArtifactIds?.[0];
    if (!task.checkId || !artifactId || !task.conditionId)
      throw conflict("Issue group has incomplete evidence; refresh and retry");
    return {
      taskId: String(task.taskId),
      originalTaskId: group.rootTaskId,
      checkId: String(task.checkId),
      artifactId: String(artifactId),
      conditionId: String(task.conditionId),
    };
  });
  return {
    kind: duplicate ? "duplicate" : targets.length > 1 ? "group" : "single",
    targets,
    members,
    links: group.links,
    rootTaskId: group.rootTaskId,
  };
}

/** Commit all cards and their durable dismissal receipts together. Analyzer
 * evidence is retained: this is an app-owned dismissal, not an upstream rejection.
 * @param {string} table @param {string} siteId
 * @param {{taskId:string,checkId:string,artifactId:string,conditionId:string,expectedTaskIds?:string[]}} input
 */
export async function deleteTaskGroup(table, siteId, input) {
  const clicked = await readTask(table, siteId, input.taskId);
  if (
    !clicked ||
    clicked.checkId !== input.checkId ||
    clicked.conditionId !== input.conditionId ||
    !clicked.sourceArtifactIds?.includes(input.artifactId)
  )
    throw conflict("Card changed; refresh and retry");
  const receiptKey = conditionDeletionKey(siteId, {}, clicked);
  if (!receiptKey) throw conflict("Missing deletion identity");
  const receipt = (
    await ddb.send(
      new GetCommand({
        TableName: table,
        Key: receiptKey,
        ConsistentRead: true,
      }),
    )
  ).Item;
  if (receipt?.deletionTargets) return receipt.deletionTargets;
  const scope = await deletionScope(table, siteId, clicked);
  if (
    input.expectedTaskIds &&
    JSON.stringify([...input.expectedTaskIds].sort()) !==
      JSON.stringify(scope.targets.map((target) => target.taskId).sort())
  )
    throw conflict("Issue group changed; reopen the deletion dialog");
  if (scope.kind === "group") {
    // Read membership again after member versions. An indirect link could join
    // before its intermediate parent's first read; later joins are caught by
    // that parent's transactional version guard.
    const checked = await deletionScope(table, siteId, clicked);
    if (
      JSON.stringify(checked.targets.map((target) => target.taskId).sort()) !==
      JSON.stringify(scope.targets.map((target) => target.taskId).sort())
    )
      throw conflict("Issue group changed; reopen the deletion dialog");
  }
  const now = new Date().toISOString();
  /** @type {any[]} */
  const writes = [];
  const receipts = new Set();
  for (const member of scope.members) {
    const task = member.taskId === clicked.taskId ? clicked : member;
    writes.push({
      Put: {
        TableName: table,
        Item: {
          ...task,
          ...taskKey(siteId, task.taskId),
          status: "superseded",
          supersededAt: now,
          updatedAt: now,
          supersessionReason: "issue_deleted",
          ...taskWorklistDateGsi(
            siteId,
            "superseded",
            task.kind,
            Number(task.severity || 0),
            now,
            task.taskId,
          ),
        },
        ConditionExpression:
          (task.updatedAt
            ? "#status = :status AND updatedAt = :updatedAt"
            : "#status = :status AND attribute_not_exists(updatedAt)") +
          " AND " +
          (task.duplicateGroupVersion
            ? "duplicateGroupVersion = :groupVersion"
            : "attribute_not_exists(duplicateGroupVersion)"),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": task.status,
          ...(task.updatedAt ? { ":updatedAt": task.updatedAt } : {}),
          ...(task.duplicateGroupVersion
            ? { ":groupVersion": task.duplicateGroupVersion }
            : {}),
        },
      },
    });
    const key = conditionDeletionKey(siteId, {}, task);
    if (!key) throw conflict("Missing deletion identity");
    if (!receipts.has(key.sk)) {
      receipts.add(key.sk);
      writes.push({
        Put: {
          TableName: table,
          Item: {
            ...key,
            state: "confirmed",
            deletedAt: now,
            deletionOrigin: "app",
            category: task.category || "unknown",
            deletionTargets: scope.targets,
          },
        },
      });
    }
  }
  // Guard every relationship consulted, including the clicked duplicate's
  // relation. A concurrent separation or link change must cancel the deletion.
  for (const link of scope.links) {
    if (scope.kind === "duplicate" && link.taskId !== clicked.taskId) continue;
    writes.push({
      ConditionCheck: {
        TableName: table,
        Key: { pk: `SITE#${siteId}`, sk: `DUP_LINK#${link.taskId}` },
        ConditionExpression:
          "originalTaskId = :root AND sourceRevision = :revision",
        ExpressionAttributeValues: {
          ":root": link.originalTaskId,
          ":revision": link.sourceRevision,
        },
      },
    });
  }
  for (const target of scope.targets.filter(
    (target) => target.taskId !== scope.rootTaskId,
  )) {
    writes.push({
      ConditionCheck: {
        TableName: table,
        Key: {
          pk: `SITE#${siteId}`,
          sk: `DUP_OVERRIDE#${JSON.stringify([target.checkId, target.artifactId, target.conditionId])}`,
        },
        ConditionExpression: "attribute_not_exists(sk)",
      },
    });
  }
  // DynamoDB's transaction limit: never partially delete a large group.
  if (writes.length > 100)
    throw conflict("Issue group is too large for one deletion");
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException")
      throw conflict("Issue group changed; refresh and retry");
    throw error;
  }
  return scope.targets;
}
