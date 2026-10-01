import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import {
  checkHeaderKey,
  taskKey,
  taskUpdateKey,
  taskUpdateMediaKey,
  taskUpdateMediaPointerKey,
  taskUpdatePointerKey,
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
export async function readTimeline(
  tableName,
  siteId,
  taskId,
  { limit = 50, cursor = "" } = {},
) {
  let exclusiveStartKey;
  if (cursor) {
    try {
      const sk = Buffer.from(cursor, "base64url").toString("utf8");
      if (!sk.startsWith(taskUpdatePrefix(taskId))) throw new Error();
      exclusiveStartKey = { pk: `SITE#${siteId}`, sk };
    } catch {
      return null;
    }
  }
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `SITE#${siteId}`,
        ":prefix": taskUpdatePrefix(taskId),
      },
      ScanIndexForward: false,
      Limit: Math.min(Math.max(Number(limit) || 50, 1), 100),
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }),
  );
  return {
    items: result.Items || [],
    nextToken: result.LastEvaluatedKey?.sk
      ? Buffer.from(String(result.LastEvaluatedKey.sk)).toString("base64url")
      : null,
  };
}

/** @param {string} tableName @param {string} siteId @param {string} taskId @param {string} updateId */
export async function readUpdateById(tableName, siteId, taskId, updateId) {
  const direct = await readUpdatePointer(tableName, siteId, taskId, updateId);
  if (direct) return direct;
  return readLegacyUpdateById(tableName, siteId, taskId, updateId);
}

/**
 * Compatibility lookup for events written before direct pointers existed.
 *
 * @param {string} tableName
 * @param {string} siteId
 * @param {string} taskId
 * @param {string} updateId
 */
export async function readLegacyUpdateById(
  tableName,
  siteId,
  taskId,
  updateId,
) {
  /** @type {Record<string, any> | undefined} */
  let exclusiveStartKey;
  do {
    const result = /** @type {any} */ (
      await ddb.send(
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
          ...(exclusiveStartKey
            ? { ExclusiveStartKey: exclusiveStartKey }
            : {}),
        }),
      )
    );
    if (result.Items?.[0]) return result.Items[0];
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return null;
}

/**
 * Direct pointer lookup without the legacy timeline fallback.
 * @param {string} tableName @param {string} siteId @param {string} taskId @param {string} updateId
 */
export async function readUpdatePointer(tableName, siteId, taskId, updateId) {
  const pointer = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: taskUpdatePointerKey(siteId, taskId, updateId),
      ConsistentRead: true,
    }),
  );
  if (pointer.Item?.updateSk) {
    const direct = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: pointer.Item.updateSk },
        ConsistentRead: true,
      }),
    );
    return direct.Item || null;
  }
  return null;
}

/**
 * Atomically append an update and replace its task snapshot.
 * @param {{ tableName: string, siteId: string, taskId: string, occurredAt: string, update: Record<string, any>, task: Record<string, any>, expectedStatus: string, expectedUpdatedAt?: string }} input
 */
export async function writeTaskTransition(input) {
  const statusOnly = input.expectedUpdatedAt === undefined;
  const updateKey = taskUpdateKey(
    input.siteId,
    input.taskId,
    input.occurredAt,
    input.update.updateId,
  );
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: input.tableName,
            Item: {
              ...updateKey,
              ...input.update,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: input.tableName,
            Item: {
              ...taskUpdatePointerKey(
                input.siteId,
                input.taskId,
                input.update.updateId,
              ),
              entityType: "task_update_pointer",
              taskId: input.taskId,
              updateId: input.update.updateId,
              updateSk: updateKey.sk,
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
  const mediaKey = taskUpdateMediaKey(
    input.siteId,
    input.taskId,
    input.artifactId,
  );
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: input.tableName,
            Item: {
              ...mediaKey,
              entityType: "task_update_media",
              checkId: input.checkId,
              artifactId: input.artifactId,
              s3Key: input.s3Key,
              contentType: input.contentType,
              capturedAt: input.capturedAt,
              purpose: "task_update",
              taskId: input.taskId,
            },
            ConditionExpression: "attribute_not_exists(sk)",
          },
        },
        {
          Put: {
            TableName: input.tableName,
            Item: {
              ...taskUpdateMediaPointerKey(
                input.siteId,
                input.checkId,
                input.artifactId,
              ),
              entityType: "task_update_media_pointer",
              checkId: input.checkId,
              taskId: input.taskId,
              artifactId: input.artifactId,
              mediaSk: mediaKey.sk,
            },
            ConditionExpression: "attribute_not_exists(sk)",
          },
        },
      ],
    }),
  );
}
