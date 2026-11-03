import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { taskKey } from "../../handlers/keys.js";

/** @param {string} table @param {string} siteId @param {string} taskId */
export async function readTask(table, siteId, taskId) {
  return (
    await ddb.send(
      new GetCommand({
        TableName: table,
        Key: taskKey(siteId, taskId),
        ConsistentRead: true,
      }),
    )
  ).Item;
}

/** @param {string} table @param {string} siteId @param {string} prefix */
async function duplicateRows(table, siteId, prefix) {
  const items = [];
  let exclusiveStartKey;
  do {
    /** @type {any} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": prefix,
        },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

/** Resolve a clicked task to the root and every still-linked group member.
 * @param {string} table @param {string} siteId @param {Record<string, any>} clickedTask
 */
export async function groupForTask(table, siteId, clickedTask) {
  const [savedLinks, overrides] = await Promise.all([
    duplicateRows(table, siteId, "DUP_LINK#"),
    duplicateRows(table, siteId, "DUP_OVERRIDE#"),
  ]);
  const separated = new Set(overrides.map((override) => override.taskId));
  const links = savedLinks.filter((link) => !separated.has(link.taskId));
  const bySource = new Map(links.map((link) => [String(link.taskId), link]));
  /** @param {string} id */
  const rootFor = (id) => {
    const seen = new Set();
    while (bySource.has(id)) {
      if (seen.has(id))
        throw Object.assign(new Error("Issue group contains a cycle"), {
          statusCode: 409,
        });
      seen.add(id);
      const link = bySource.get(id);
      if (!link) break;
      id = String(link.originalTaskId);
    }
    return id;
  };
  const rootTaskId = rootFor(String(clickedTask.taskId));
  // A selected-card dismissal leaves sightings intact and independently actionable.
  // Saved historical links must not route them back to a deleted original.
  const root =
    rootTaskId === clickedTask.taskId
      ? clickedTask
      : await readTask(table, siteId, rootTaskId);
  if (
    root &&
    ["superseded", "deleted"].includes(root.status) &&
    rootTaskId !== clickedTask.taskId
  )
    return {
      tasks: [clickedTask],
      links: [],
      rootTaskId: clickedTask.taskId,
      root: clickedTask,
      members: [{ ...clickedTask, isDuplicate: false }],
    };
  // Walk incoming edges from this root only. A corrupt unrelated component
  // must not prevent opening or deleting the selected card.
  const members = new Set([rootTaskId]);
  /** @type {Record<string,any>[]} */
  const memberLinks = [];
  const incoming = new Map();
  for (const link of links) {
    const parent = String(link.originalTaskId);
    const rows = incoming.get(parent) || [];
    rows.push(link);
    incoming.set(parent, rows);
  }
  for (const parent of members) {
    for (const link of incoming.get(parent) || []) {
      const id = String(link.taskId);
      if (members.has(id)) continue;
      members.add(id);
      memberLinks.push(link);
    }
  }
  const ids = [rootTaskId, ...memberLinks.map((link) => String(link.taskId))];
  const tasks = /** @type {Record<string, any>[]} */ (
    await Promise.all(
      [...new Set(ids)].map((id) => readTask(table, siteId, id)),
    )
  ).filter(Boolean);
  return {
    tasks,
    links: memberLinks,
    rootTaskId,
    root: tasks.find((task) => task.taskId === rootTaskId),
    members: tasks
      .map((task) => ({
        ...task,
        isDuplicate: task.taskId !== rootTaskId,
        ...(memberLinks.find((link) => link.taskId === task.taskId) ?? {}),
      }))
      .sort((a, b) =>
        String(/** @type {Record<string, any>} */ (b).createdAt).localeCompare(
          String(/** @type {Record<string, any>} */ (a).createdAt),
        ),
      ),
  };
}
