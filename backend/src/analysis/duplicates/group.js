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
  const memberLinks = links.filter(
    (link) => rootFor(String(link.taskId)) === rootTaskId,
  );
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
