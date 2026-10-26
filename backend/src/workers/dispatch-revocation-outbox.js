import { projectStatus } from "../domain/system-status.js";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { getConfig } from "../config.js";
import { ddb } from "../db.js";

const sqs = new SQSClient({});

/**
 * Project system-status events and forward durable outbox inserts to SQS. DynamoDB Streams retries failures,
 * closing the API's former commit-then-send crash window. Duplicate delivery is
 * safe because reconciliation verifies already-revoked projections.
 * @type {import("aws-lambda").DynamoDBStreamHandler}
 */
export const handler = async (event) => {
  for (const record of event.Records) {
    const image = record.dynamodb?.NewImage;
    if (!image) continue;
    const item = /** @type {Record<string, any>} */ (
      unmarshall(
        /** @type {Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>} */ (
          /** @type {unknown} */ (image)
        ),
      )
    );
    await projectStatus(item);
    if (record.eventName !== "INSERT") continue;
    if (
      ![
        "REVOCATION_OUTBOX",
        "COMPLIANCE_LETTER_OUTBOX",
        "SF311_OUTBOX",
      ].includes(item.entityType) ||
      item.status !== "pending"
    ) {
      continue;
    }
    const config = getConfig();
    const current = await ddb.send(
      new GetCommand({
        TableName: config.dynamoTable,
        Key: { pk: item.pk, sk: item.sk },
        ConsistentRead: true,
      }),
    );
    if (current.Item?.status !== "pending") continue;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: config.queueUrl,
        MessageBody: JSON.stringify(
          item.entityType === "SF311_OUTBOX"
            ? {
                type: "sf311_job",
                siteId: item.siteId,
                taskId: item.taskId,
                jobPk: item.pk,
                jobSk: item.sk,
              }
            : item.entityType === "COMPLIANCE_LETTER_OUTBOX"
              ? {
                  type: "generate_compliance_letter",
                  siteId: item.siteId,
                  jobPk: item.pk,
                  jobSk: item.sk,
                  previousLetters: item.previousLetters || [],
                }
              : {
                  type: "reconcile_site_revocation",
                  operationId: item.operationId,
                  operationPk: item.operationPk,
                  siteId: item.siteId,
                  startedAt: item.startedAt,
                  actor: item.actor,
                },
        ),
      }),
    );
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: config.dynamoTable,
          Key: { pk: item.pk, sk: item.sk },
          UpdateExpression: "SET #status = :dispatched, dispatchedAt = :now",
          ConditionExpression: "#status = :pending",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":pending": "pending",
            ":dispatched": "dispatched",
            ":now": new Date().toISOString(),
          },
        }),
      );
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      const latest = await ddb.send(
        new GetCommand({
          TableName: config.dynamoTable,
          Key: { pk: item.pk, sk: item.sk },
          ConsistentRead: true,
        }),
      );
      if (latest.Item?.status !== "dispatched") throw error;
    }
  }
};

/** @param {unknown} error */
function isConditionalConflict(error) {
  return (
    error instanceof Error &&
    [
      "ConditionalCheckFailedException",
      "TransactionCanceledException",
    ].includes(error.name)
  );
}
