import { duplicateEvent } from "../analysis/duplicates/monitoring.js";
// Separate stream dispatcher. Existing analysis handlers have no dependency here.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { pendingConditions } from "../analysis/duplicates/result-state.js";
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
      if (!previous && current.sk?.startsWith("DUP_OVERRIDE#")) {
        duplicateEvent(
          "separated",
          {
            siteId: current.pk.slice(5),
            taskId: current.taskId,
            originalTaskId: current.originalTaskId,
          },
          [{ name: "DuplicateSeparated", value: 1 }],
        );
      }
      if (
        current.sk?.startsWith("DUP_LINK#") &&
        (!previous || previous.updateId !== current.updateId)
      ) {
        duplicateEvent(
          "linked",
          {
            siteId: current.pk.slice(5),
            taskId: current.taskId,
            originalTaskId: current.originalTaskId,
          },
          [{ name: "DuplicateLinksCreated", value: 1 }],
        );
      }
      // Guidance publication may finish after the isolated comparison. Reconcile
      // links without rerunning analysis or asking the model again.
      if (
        current.entityType === "TASK" &&
        current.checkId &&
        current.sourceArtifactIds?.length &&
        (!previous ||
          current.assessmentId !== previous.assessmentId ||
          (current.status !== previous.status &&
            ["in_progress", "completed"].includes(current.status)) ||
          current.resolvedAt !== previous.resolvedAt)
      ) {
        for (const artifactId of current.sourceArtifactIds)
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: process.env.DUPLICATE_QUEUE_URL,
              MessageBody: JSON.stringify({
                siteId: current.pk.slice(5),
                checkId: current.checkId,
                artifactId,
                reconcileOnly: true,
              }),
            }),
          );
      }
      // Artifact registration follows validated S3 upload. Warm the isolated
      // preparation cache while normal analysis runs on its own queue/capacity.
      if (
        /^CHECK#[^#]+#ART#[^#]+$/.test(current.sk ?? "") &&
        current.s3Key &&
        current.s3Key !== previous?.s3Key
      ) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: process.env.DUPLICATE_QUEUE_URL,
            MessageBody: JSON.stringify({
              siteId: current.pk.slice(5),
              checkId: current.checkId,
              artifactId: current.artifactId,
              prepareOnly: true,
            }),
          }),
        );
      }
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
                processingState: "pending",
                conditionResults: pendingConditions(
                  (current.concerns ?? [])
                    .filter(
                      (
                        /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
                      ) => c.rating > 0 && c.conditionId,
                    )
                    .map(
                      (
                        /** @type {Record<string, import("@aws-sdk/util-dynamodb").NativeAttributeValue>} */ c,
                      ) => ({ id: c.conditionId }),
                    ),
                ),
                queuedAt: new Date().toISOString(),
                analysisReadyAt: current.analyzedAt,
                possibleDuplicate: null,
                shadow: false,
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
            enqueuedAt: new Date().toISOString(),
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
