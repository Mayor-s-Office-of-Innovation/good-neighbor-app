import { sf311Job } from "../guidance/sf311-job.js";
import { duplicateForTask, siteReader } from "./links.js";
import { evidenceCondition } from "./evidence-check.js";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { taskKey, taskWorklistDateGsi } from "../../handlers/keys.js";
import { conditionDeletionKey } from "../guidance/guidance-store.js";
import { groupForTask, readTask } from "./group.js";

/** @param {string} message @param {string} [code] */
function conflict(message, code = "group_changed") {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

/** The confirmation and the write use exactly the same server-owned scope.
 * @param {string} table @param {string} siteId @param {Record<string, any>} clicked
 * @param {Awaited<ReturnType<typeof groupForTask>>} [knownGroup]
 */
export async function deletionScope(table, siteId, clicked, knownGroup) {
  if (["superseded", "deleted"].includes(clicked.status))
    throw conflict(
      "Card was already deleted; refresh and retry",
      "already_deleted",
    );
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
        clickedRelation.state === "pending"
          ? "matching_pending"
          : "matching_unavailable",
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
            relation.state === "pending"
              ? "matching_pending"
              : "matching_unavailable",
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
    throw conflict(
      "Card was already deleted; refresh and retry",
      "already_deleted",
    );
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

/** Selected-card deletion never depends on duplicate matching or group traversal.
 * @param {Record<string, any>} clicked
 */
export function selectedDeletionScope(clicked) {
  if (["superseded", "deleted"].includes(clicked.status))
    throw conflict("Card was already deleted", "already_deleted");
  const artifactId = clicked.sourceArtifactIds?.[0];
  if (
    !clicked.taskId ||
    !clicked.checkId ||
    !artifactId ||
    !clicked.conditionId
  )
    throw conflict("Missing deletion identity", "identity_unavailable");
  return {
    kind: "single",
    rootTaskId: clicked.taskId,
    members: [clicked],
    links: [],
    proof: new Map(),
    targets: [
      {
        taskId: String(clicked.taskId),
        originalTaskId: String(clicked.taskId),
        checkId: String(clicked.checkId),
        artifactId: String(artifactId),
        conditionId: String(clicked.conditionId),
      },
    ],
  };
}

/** Count unique items, including every evidence guard, before confirmation.
 * @param {string} siteId @param {Awaited<ReturnType<typeof deletionScope>>} scope
 */
export function checkDeletionSize(siteId, scope) {
  const keys = new Set(
    scope.members.flatMap((task) => [
      taskKey(siteId, task.taskId).sk,
      conditionDeletionKey(siteId, {}, task)?.sk,
    ]),
  );
  for (const task of scope.members) {
    for (const entry of sf311Job("unused", siteId, task, "deleted")) {
      if (entry.Put) keys.add(String(entry.Put.Item?.sk));
    }
  }
  for (const link of scope.links) {
    if (scope.kind !== "duplicate" || link.taskId === scope.members[0]?.taskId)
      keys.add(`DUP_LINK#${link.taskId}`);
  }
  for (const key of scope.proof.keys()) keys.add(key);
  if (keys.size > 100)
    throw conflict(
      "Issue group is too large for one deletion",
      "group_too_large",
    );
}

/** Commit all cards and their durable dismissal receipts together. Analyzer
 * evidence is retained: this is an app-owned dismissal, not an upstream rejection.
 * @param {string} table @param {string} siteId
 * @param {{taskId:string,checkId:string,artifactId:string,conditionId:string,expectedTaskIds?:string[],mode?:"selected"}} input
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
  if (receipt?.deletionTargets) {
    const targets =
      input.mode === "selected"
        ? receipt.deletionTargets.filter(
            (/** @type {{taskId:string}} */ target) =>
              target.taskId === clicked.taskId,
          )
        : receipt.deletionTargets;
    // A replay must not claim a newly confirmed, wider group was removed by an
    // earlier selected-only deletion. Restore that caller's optimistic overlay.
    if (
      input.expectedTaskIds !== undefined &&
      JSON.stringify([...input.expectedTaskIds].sort()) !==
        JSON.stringify(
          targets
            .map((/** @type {{taskId:string}} */ target) => target.taskId)
            .sort(),
        )
    )
      throw conflict("Deletion scope changed; reopen the deletion dialog");
    return targets;
  }
  if (
    !Array.isArray(input.expectedTaskIds) ||
    !input.expectedTaskIds.length ||
    input.expectedTaskIds.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(input.expectedTaskIds).size !== input.expectedTaskIds.length
  )
    throw conflict(
      "Missing confirmed deletion scope; reopen the deletion dialog",
    );
  const scope =
    input.mode === "selected"
      ? selectedDeletionScope(clicked)
      : await deletionScope(table, siteId, clicked);
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
    writes.push(...sf311Job(table, siteId, { ...task, ...updates }, "deleted"));
    writes.push({
      Update: {
        TableName: table,
        Key: taskKey(siteId, task.taskId),
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression:
          (task.updatedAt
            ? "#status = :status AND updatedAt = :updatedAt"
            : "#status = :status AND attribute_not_exists(updatedAt)") +
          (input.mode === "selected"
            ? ""
            : " AND " +
              (task.duplicateGroupVersion
                ? "duplicateGroupVersion = :groupVersion"
                : "attribute_not_exists(duplicateGroupVersion)")),
        ExpressionAttributeNames: { "#status": "status", ...updateNames },
        ExpressionAttributeValues: {
          ...updateValues,
          ":status": task.status,
          ...(task.updatedAt ? { ":updatedAt": task.updatedAt } : {}),
          ...(input.mode !== "selected" && task.duplicateGroupVersion
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
  // Remove only the selected card's outgoing saved link. In particular, this
  // breaks a corrupt cycle without changing any other card or its evidence.
  if (input.mode === "selected")
    writes.push({
      Delete: {
        TableName: table,
        Key: { pk: `SITE#${siteId}`, sk: `DUP_LINK#${clicked.taskId}` },
      },
    });
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
    throw conflict(
      "Issue group is too large for one deletion",
      "group_too_large",
    );
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: writes }));
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionCanceledException")
      throw conflict("Issue group changed; refresh and retry");
    throw error;
  }
  return scope.targets;
}
