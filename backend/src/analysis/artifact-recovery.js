import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { artifactKey } from "../handlers/keys.js";

export const MAX_ANALYSIS_DELIVERIES = 5;

/** @param {unknown} error */
export function recoveryConflict(error) {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  const reasons = /** @type {{ CancellationReasons?: {Code?: string}[] }} */ (
    error
  ).CancellationReasons;
  return (
    error.name === "TransactionCanceledException" &&
    Boolean(
      reasons?.some((reason) => reason.Code === "ConditionalCheckFailed"),
    ) &&
    Boolean(
      reasons?.every((reason) =>
        ["None", "ConditionalCheckFailed"].includes(reason.Code || "None"),
      ),
    )
  );
}

/** Claim before any analyzer call. The lease also suppresses duplicate registration sends.
 * @param {string} table @param {any} msg
 */
export async function claimAnalysis(table, msg) {
  if (!msg.analysisGeneration) return true; // Messages queued before rollout.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: artifactKey(msg.siteId, msg.checkId, msg.artifactId),
        UpdateExpression:
          "SET analysisStatus = :running, analysisLeaseUntil = :lease",
        ConditionExpression:
          "analysisGeneration = :generation AND (analysisStatus = :queued OR (analysisStatus = :running AND analysisLeaseUntil < :now))",
        ExpressionAttributeValues: {
          ":generation": msg.analysisGeneration,
          ":queued": "queued",
          ":running": "running",
          ":now": Date.now(),
          ":lease": Date.now() + 330_000,
        },
      }),
    );
    return true;
  } catch (error) {
    if (recoveryConflict(error)) return false;
    throw error;
  }
}

/** Publish a result and its lifecycle atomically, fenced against older generations.
 * @param {string} table @param {any} msg @param {any} item @param {string} status
 */
export async function publishAnalysis(table, msg, item, status) {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: table,
            Key: artifactKey(msg.siteId, msg.checkId, msg.artifactId),
            UpdateExpression:
              "SET analysisStatus = :status REMOVE analysisLeaseUntil",
            ConditionExpression:
              "analysisGeneration = :generation AND analysisStatus IN (:queued, :running)",
            ExpressionAttributeValues: {
              ":generation": msg.analysisGeneration,
              ":status": status,
              ":queued": "queued",
              ":running": "running",
            },
          },
        },
        {
          Put: {
            TableName: table,
            Item: { ...item, analysisGeneration: msg.analysisGeneration },
          },
        },
      ],
    }),
  );
}

/** @param {string} table @param {any} msg */
export async function releaseAnalysis(table, msg) {
  if (!msg.analysisGeneration) return;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: artifactKey(msg.siteId, msg.checkId, msg.artifactId),
        UpdateExpression:
          "SET analysisStatus = :queued REMOVE analysisLeaseUntil",
        ConditionExpression:
          "analysisGeneration = :generation AND analysisStatus = :running",
        ExpressionAttributeValues: {
          ":generation": msg.analysisGeneration,
          ":queued": "queued",
          ":running": "running",
        },
      }),
    );
  } catch (error) {
    if (!recoveryConflict(error)) throw error;
  }
}

/** Idempotent restart: request identity is the new generation, only exhausted jobs qualify.
 * @param {string} table @param {any} key @param {string} requestId @param {string} expected
 */
export async function restartAnalysis(table, key, requestId, expected) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: key,
        UpdateExpression:
          "SET analysisGeneration = :request, analysisStatus = :queued REMOVE analysisLeaseUntil",
        ConditionExpression:
          "analysisGeneration = :expected AND analysisStatus = :exhausted",
        ExpressionAttributeValues: {
          ":request": requestId,
          ":expected": expected,
          ":queued": "queued",
          ":exhausted": "exhausted",
        },
      }),
    );
    return true;
  } catch (error) {
    if (!recoveryConflict(error)) throw error;
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table, Key: key, ConsistentRead: true }),
    );
    return Item?.analysisGeneration === requestId;
  }
}
