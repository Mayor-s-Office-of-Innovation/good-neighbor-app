import { inactiveSf311Lease } from "../../domain/sf311-lease.js";
import { definitiveSilentFailure } from "../../domain/silent-311-results.js";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../db.js";
import { queryAllItems } from "../../lib/query-all-items.js";
import { taskWorklistDateGsi } from "../../handlers/keys.js";

/** @param {string} siteId @param {string} checkId @param {string} artifactId */
export const evidenceDeletionKey = (siteId, checkId, artifactId) => ({
  pk: `SITE#${siteId}`,
  sk: `EVIDENCE_DELETION#${JSON.stringify([checkId, artifactId])}`,
});

/** Publication and deletion serialize on the same durable marker.
 * @param {string} tableName @param {string} siteId @param {string} checkId @param {string[]} artifactIds
 */
export function evidencePublicationGuards(
  tableName,
  siteId,
  checkId,
  artifactIds,
) {
  return [...new Set(artifactIds)].filter(Boolean).map((artifactId) => ({
    ConditionCheck: {
      TableName: tableName,
      Key: evidenceDeletionKey(siteId, checkId, artifactId),
      ConditionExpression: "attribute_not_exists(pk)",
    },
  }));
}

/** @param {Record<string, any>} row */
export function evidenceIds(row) {
  return [...new Set(row.sourceArtifactIds || row.source?.artifactIds || [])];
}

/** Only outcomes proving no external effect are safe to retract.
 * @param {Record<string, any>[]} results
 */
function retractableResults(results) {
  return results.every(
    (result) =>
      !/uncertain|reconciliation/.test(String(result.reason || "")) &&
      (["skipped", "not_configured", "requires_user_action"].includes(
        result.status,
      ) ||
        definitiveSilentFailure(result)),
  );
}

/** Do not retract work with independent evidence or recorded actions.
 * @param {Record<string, any>} task @param {string} artifactId
 */
export function retractableTask(task, artifactId) {
  const ids = evidenceIds(task);
  return (
    task.status === "open" &&
    ids.length === 1 &&
    ids[0] === artifactId &&
    !task.actionOverride &&
    !task.customAction &&
    !task.latestUpdateId &&
    !task.completedAt &&
    !task.resolvedAt &&
    !task.inProgressAt &&
    !task.inProgressActionKind &&
    retractableResults(task.appActionResults || [])
  );
}

/** Retriable cleanup after the marker has prevented new guidance publication.
 * Reads base-table rows, not an eventually consistent worklist index.
 * @param {{tableName:string, siteId:string, checkId:string, artifactId:string}} input
 */
export async function retractEvidenceTasks({
  tableName,
  siteId,
  checkId,
  artifactId,
}) {
  const { Items } = await queryAllItems({
    TableName: tableName,
    ConsistentRead: true,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    FilterExpression: "checkId = :check",
    ExpressionAttributeValues: {
      ":pk": `SITE#${siteId}`,
      ":prefix": "TASK#",
      ":check": checkId,
    },
  });
  for (let task of Items.filter((row) => retractableTask(row, artifactId))) {
    for (let attempt = 0; ; attempt++) {
      if (!retractableTask(task, artifactId)) break;
      const now = new Date().toISOString();
      const lockKey = { pk: task.pk, sk: `SF311_LOCK#${task.taskId}` };
      const { Item: lock } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: lockKey,
          ConsistentRead: true,
        }),
      );
      const leaseGuard = inactiveSf311Lease(lock, now);
      if (!leaseGuard || !retractableResults(lock?.results || []))
        throw Object.assign(
          new Error("Evidence cleanup is waiting for filing to settle"),
          { name: "EvidenceDeletionPending" },
        );
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: {
                    ...task,
                    status: "superseded",
                    supersededAt: now,
                    updatedAt: now,
                    supersessionReason: "evidence_deleted",
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
                    "#status = :open AND " +
                    (task.updatedAt
                      ? "updatedAt = :version"
                      : "attribute_not_exists(updatedAt)") +
                    " AND " +
                    (task.appActionResults
                      ? "appActionResults = :results"
                      : "attribute_not_exists(appActionResults)"),
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":open": "open",
                    ...(task.appActionResults
                      ? { ":results": task.appActionResults }
                      : {}),
                    ...(task.updatedAt ? { ":version": task.updatedAt } : {}),
                  },
                },
              },
              {
                ConditionCheck: {
                  TableName: tableName,
                  Key: lockKey,
                  ConditionExpression:
                    leaseGuard.ConditionExpression +
                    " AND " +
                    (lock?.results !== undefined
                      ? "results = :lockResults"
                      : "attribute_not_exists(results)"),
                  ...(lock?.results !== undefined ||
                  Object.keys(leaseGuard.ExpressionAttributeValues).length
                    ? {
                        ExpressionAttributeValues: {
                          ...leaseGuard.ExpressionAttributeValues,
                          ...(lock?.results !== undefined
                            ? { ":lockResults": lock.results }
                            : {}),
                        },
                      }
                    : {}),
                },
              },
            ],
          }),
        );
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "TransactionCanceledException" ||
          attempt >= 2
        )
          throw error;
        const current = await ddb.send(
          new GetCommand({
            TableName: tableName,
            Key: { pk: task.pk, sk: task.sk },
            ConsistentRead: true,
          }),
        );
        if (!current.Item) break;
        task = current.Item;
      }
    }
  }
}
