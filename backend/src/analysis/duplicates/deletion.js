import { duplicateForTask, siteReader } from "./links.js";
import { evidenceCondition } from "./evidence-check.js";
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
  if (["superseded", "deleted"].includes(clicked.status))
    throw conflict("Card was already deleted; refresh and retry");
  const group = knownGroup || (await groupForTask(table, siteId, clicked));
  const base = siteReader(table, siteId);
  /** @type {Map<string, {key:{pk:string,sk:string},item:Record<string,any>|undefined}>} */
  const proof = new Map();
  /** @param {{pk:string,sk:string}} key */
  const get = async (key) => {
    if (!proof.has(key.sk)) proof.set(key.sk, { key, item: await base(key) });
    return proof.get(key.sk)?.item;
  };
  let rootTaskId = group.rootTaskId;
  let members = group.tasks.filter(
    (task) => !["superseded", "deleted"].includes(task.status),
  );
  if (group.links.length) {
    const clickedRelation = await duplicateForTask(table, siteId, clicked, get);
    if (["pending", "unavailable"].includes(clickedRelation.state))
      throw conflict(
        "Duplicate evidence is being refreshed; retry deletion later",
      );
    rootTaskId =
      clickedRelation.state === "matched"
        ? clickedRelation.original.taskId
        : clicked.taskId;
    if (rootTaskId !== clicked.taskId) members = [clicked];
    else {
      const validated = [clicked];
      for (const task of members) {
        if (task.taskId === clicked.taskId) continue;
        if (!group.links.some((link) => link.taskId === task.taskId)) continue;
        const relation = await duplicateForTask(table, siteId, task, get);
        if (["pending", "unavailable"].includes(relation.state))
          throw conflict(
            "Duplicate evidence is being refreshed; retry deletion later",
          );
        if (
          relation.state === "matched" &&
          relation.original.taskId === rootTaskId
        )
          validated.push(task);
      }
      members = validated;
    }
  }
  const duplicate = rootTaskId !== clicked.taskId;
  if (!members.length)
    throw conflict("Card was already deleted; refresh and retry");
  const targets = members.map((task) => {
    const artifactId = task.sourceArtifactIds?.[0];
    if (!task.checkId || !artifactId || !task.conditionId)
      throw conflict("Issue group has incomplete evidence; refresh and retry");
    return {
      taskId: String(task.taskId),
      originalTaskId: rootTaskId,
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
    rootTaskId,
    proof,
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
  if (
    !Array.isArray(input.expectedTaskIds) ||
    !input.expectedTaskIds.length ||
    input.expectedTaskIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(input.expectedTaskIds).size !== input.expectedTaskIds.length
  )
    throw conflict(
      "Missing confirmed deletion scope; reopen the deletion dialog",
    );
  const scope = await deletionScope(table, siteId, clicked);
  if (
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
    const updates = {
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
    };
    /** @type {Record<string,string>} */
    const updateNames = {};
    /** @type {Record<string,any>} */
    const updateValues = {};
    const assignments = Object.entries(updates).map(([field, value], index) => {
      updateNames[`#set${index}`] = field;
      updateValues[`:set${index}`] = value;
      return `#set${index} = :set${index}`;
    });
    writes.push({
      Update: {
        TableName: table,
        Key: taskKey(siteId, task.taskId),
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression:
          (task.updatedAt
            ? "#status = :status AND updatedAt = :updatedAt"
            : "#status = :status AND attribute_not_exists(updatedAt)") +
          " AND " +
          (task.duplicateGroupVersion
            ? "duplicateGroupVersion = :groupVersion"
            : "attribute_not_exists(duplicateGroupVersion)"),
        ExpressionAttributeNames: { "#status": "status", ...updateNames },
        ExpressionAttributeValues: {
          ...updateValues,
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
  for (const { key, item } of scope.proof.values()) {
    const condition = evidenceCondition(item);
    const existing = writes.find((entry) => {
      const target =
        entry.Update?.Key || entry.Put?.Item || entry.ConditionCheck?.Key;
      return target.pk === key.pk && target.sk === key.sk;
    });
    if (existing) {
      const write = existing.Update || existing.Put || existing.ConditionCheck;
      write.ConditionExpression = write.ConditionExpression
        ? `(${write.ConditionExpression}) AND (${condition.ConditionExpression})`
        : condition.ConditionExpression;
      write.ExpressionAttributeNames = {
        ...write.ExpressionAttributeNames,
        ...condition.ExpressionAttributeNames,
      };
      write.ExpressionAttributeValues = {
        ...write.ExpressionAttributeValues,
        ...condition.ExpressionAttributeValues,
      };
      if (!Object.keys(write.ExpressionAttributeNames).length)
        delete write.ExpressionAttributeNames;
      if (!Object.keys(write.ExpressionAttributeValues).length)
        delete write.ExpressionAttributeValues;
    } else
      writes.push({
        ConditionCheck: { TableName: table, Key: key, ...condition },
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
