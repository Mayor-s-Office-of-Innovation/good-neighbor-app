// Separate stream dispatcher. Existing analysis handlers have no dependency here.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  needsDuplicateJob,
  analysisRevision,
} from "../analysis/duplicates/jobs.js";
const sqs = new SQSClient({});
/** @type {import("aws-lambda").DynamoDBStreamHandler} */
export const handler = async (event) => {
  const failures = [];
  for (const record of event.Records) {
    try {
      if (!record.dynamodb?.NewImage) continue;
      const current = unmarshall(
        /** @type {Parameters<typeof unmarshall>[0]} */ (
          record.dynamodb.NewImage
        ),
      );
      const previous = record.dynamodb.OldImage
        ? unmarshall(
            /** @type {Parameters<typeof unmarshall>[0]} */ (
              record.dynamodb.OldImage
            ),
          )
        : undefined;
      const lifecycleChange =
        current.sk?.startsWith("DUP_OBSERVATION#") &&
        previous &&
        current.resolvedAt !== previous.resolvedAt;
      if (!lifecycleChange && !needsDuplicateJob(previous, current)) continue;
      const revision = lifecycleChange
        ? current.revision
        : analysisRevision(current);
      const siteId = current.pk.slice(5);
      if (!lifecycleChange && process.env.DYNAMO_TABLE) {
        try {
          await ddb.send(
            new PutCommand({
              TableName: process.env.DYNAMO_TABLE,
              Item: {
                pk: current.pk,
                sk: `DUP_RESULT#${current.checkId}:${current.artifactId}#${revision}`,
                status: "pending",
                possibleDuplicate: null,
                shadow: true,
                sourceRevision: revision,
              },
              ConditionExpression: "attribute_not_exists(sk)",
            }),
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.name !== "ConditionalCheckFailedException"
          )
            throw error;
        }
      }
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: process.env.DUPLICATE_QUEUE_URL,
          MessageBody: JSON.stringify({
            siteId,
            checkId: current.checkId,
            artifactId: current.artifactId,
            revision,
            ...(lifecycleChange
              ? {
                  lifecycleChange: true,
                  observedAt: current.observedAt,
                  id: current.id,
                }
              : {}),
          }),
        }),
      );
    } catch {
      if (!record.dynamodb?.SequenceNumber)
        throw new Error("Missing stream sequence number");
      failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
};
