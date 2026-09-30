import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import {
  artifactKey,
  checkHeaderKey,
  taskKey,
  taskUpdateKey,
  taskUpdatePrefix,
  taskWorklistDateGsi,
} from "../handlers/keys.js";

/** @param {string} tableName @param {string} siteId @param {string} taskId */
export async function readTask(tableName, siteId, taskId) {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: taskKey(siteId, taskId),
      ConsistentRead: true,
    }),
  );
  return result.Item || null;
}

/** @param {string} tableName @param {string} siteId @param {string} checkId */
export async function readCheckHeader(tableName, siteId, checkId) {
  if (!checkId) return null;
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: checkHeaderKey(siteId, checkId),
      ConsistentRead: true,
    }),
  );
  return result.Item || null;
}

/** @param {string} tableName @param {string} siteId @param {string} taskId */
export async function readTimeline(tableName, siteId, taskId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": taskUpdatePrefix(taskId),
      },
      ScanIndexForward: false,
    }),
  );
  return result.Items || [];
}

/** @param {string} tableName @param {string} siteId @param {string} taskId @param {string} updateId */
export async function readUpdateById(tableName, siteId, taskId, updateId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      ConsistentRead: true,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      FilterExpression: "updateId = :updateId",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": taskUpdatePrefix(taskId),
        ":updateId": updateId,
      },
    }),
  );
  return result.Items?.[0] || null;
}

/** @param {string} tableName @param {Record<string, any>[]} updates */
export async function sealOpenUpdates(tableName, updates) {
  return Promise.all(
    updates.map(async (update) => {
      if (update.documentationState !== "open_for_documentation") return update;
      const sealed = {
        ...update,
        documentationState: "closed",
        documentedAt: new Date().toISOString(),
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: tableName,
                  Item: sealed,
                  ConditionExpression: "documentationState = :open",
                  ExpressionAttributeValues: {
                    ":open": "open_for_documentation",
                  },
                },
              },
            ],
          }),
        );
        return sealed;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "TransactionCanceledException"
        )
          return update;
        throw error;
      }
    }),
  );
}

/**
 * Atomically append an update and replace its task snapshot.
 * @param {{ tableName: string, siteId: string, taskId: string, occurredAt: string, update: Record<string, any>, task: Record<string, any>, expectedStatus: string, expectedUpdatedAt?: string }} input
 */
export async function writeTaskTransition(input) {
  const statusOnly = input.expectedUpdatedAt === undefined;
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: input.tableName,
            Item: {
              ...taskUpdateKey(
                input.siteId,
                input.taskId,
                input.occurredAt,
                input.update.updateId,
              ),
              ...input.update,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: input.tableName,
            Item: {
              ...input.task,
              ...taskWorklistDateGsi(
                input.siteId,
                String(input.task.status || ""),
                String(input.task.kind || ""),
                Number(input.task.severity || 0),
                String(input.task.updatedAt || input.occurredAt),
                input.taskId,
              ),
            },
            ConditionExpression: statusOnly
              ? "#status = :expected"
              : "#status = :expected AND updatedAt = :prior",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":expected": input.expectedStatus,
              ...(statusOnly ? {} : { ":prior": input.expectedUpdatedAt }),
            },
          },
        },
      ],
    }),
  );
}

/** @param {string} tableName @param {Record<string, any>} update */
export async function writeDocumentedUpdate(tableName, update) {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: update,
            ConditionExpression: "documentationState = :open",
            ExpressionAttributeValues: { ":open": "open_for_documentation" },
          },
        },
      ],
    }),
  );
}

/** @param {{ tableName: string, siteId: string, checkId: string, taskId: string, artifactId: string, s3Key: string, contentType: string, capturedAt: string }} input */
export async function writeTaskUpdateMedia(input) {
  await ddb.send(
    new PutCommand({
      TableName: input.tableName,
      Item: {
        ...artifactKey(input.siteId, input.checkId, input.artifactId),
        checkId: input.checkId,
        artifactId: input.artifactId,
        s3Key: input.s3Key,
        contentType: input.contentType,
        capturedAt: input.capturedAt,
        purpose: "task_update",
        taskId: input.taskId,
      },
      ConditionExpression: "attribute_not_exists(sk)",
    }),
  );
}
