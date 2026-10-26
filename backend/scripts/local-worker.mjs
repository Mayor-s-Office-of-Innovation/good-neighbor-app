import { handler as sf311Job } from "../src/workers/sf311-job.js";
import { projectStatus, statusRecords } from "../src/domain/system-status.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { expireComplianceTerms } from "../src/workers/expire-compliance-terms.js";
// SQS → worker pump — the local stand-in for the Lambda event source mapping.
// Long-polls ElasticMQ, wraps each message in an SQSEvent, invokes the SAME
// exported worker handler we deploy, and deletes the message only after the
// handler succeeds (so a throw leaves it for redelivery, like real SQS).

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { ensureLocalInfra } from "./lib/ensure-infra.mjs";
import { getConfig } from "../src/config.js";
import { ddb } from "../src/db.js";
import { handler as processSubmission } from "../src/workers/process-submission.js";
import { handler as analyzeArtifact } from "../src/workers/analyze-artifact.js";
import { handler as reconcileSiteRevocation } from "../src/workers/reconcile-site-revocation.js";
import { handler as dispatchOutbox } from "../src/workers/dispatch-revocation-outbox.js";
import { handler as generateComplianceLetter } from "../src/workers/generate-compliance-letter.js";
import { handler as translateArtifact } from "../src/workers/translate-artifact.js";
import { handler as analyzeComplaint } from "../src/workers/analyze-complaint.js";
import { TRANSLATE_MESSAGE_TYPE } from "../src/analysis/translate-enqueue.js";

const sqs = new SQSClient({});
let running = true;

/**
 * Reduce a thrown error to compact, non-sensitive fields for logging. The worker
 * drives the analyzer path, whose requests carry GNP's `x-api-key` credential, so
 * we never dump a raw error object here — a nested field could put the key in
 * clear-text logs. Name + message (built from literals) plus `code`/`status` are
 * enough to triage a redelivery.
 * @param {unknown} err
 * @returns {string}
 */
function summarizeError(err) {
  if (!(err instanceof Error)) return String(err);
  const e = /** @type {any} */ (err);
  const tail = [
    e.code != null ? `code=${e.code}` : null,
    e.status != null ? `status=${e.status}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return tail
    ? `${err.name}: ${err.message} (${tail})`
    : `${err.name}: ${err.message}`;
}

/**
 * The async flows share SQS_QUEUE_URL, so the local pump picks the handler by
 * message shape.
 * The register handler enqueues an analyze message carrying s3Key + artifactId;
 * the demo /submissions flow does not. Anything without both goes to the
 * submission handler (unchanged default).
 * @param {string | undefined} body
 * @returns {import("aws-lambda").SQSHandler}
 */
function pickHandler(body) {
  try {
    const msg = JSON.parse(body ?? "");
    if (msg?.type === "sf311_job") return sf311Job;
    if (msg?.type === "reconcile_site_revocation") {
      return reconcileSiteRevocation;
    }
    if (msg?.type === "generate_compliance_letter") {
      return generateComplianceLetter;
    }
    if (msg?.type === TRANSLATE_MESSAGE_TYPE) {
      return translateArtifact;
    }
    if (msg?.type === "analyze_complaint") return analyzeComplaint;
    // Analyze messages carry an artifactId plus either an S3 key (photo) or text
    // (description). The demo /submissions flow carries neither.
    if (
      typeof msg?.artifactId === "string" &&
      (typeof msg?.s3Key === "string" || typeof msg?.text === "string")
    ) {
      return analyzeArtifact;
    }
  } catch {
    // Non-JSON body → fall through to the submission handler.
  }
  return processSubmission;
}

/**
 * Wrap one SQS message in the SQSEvent shape the worker expects.
 * @param {import("@aws-sdk/client-sqs").Message} msg
 * @returns {import("aws-lambda").SQSEvent}
 */
function toSqsEvent(msg) {
  return /** @type {import("aws-lambda").SQSEvent} */ ({
    Records: [
      {
        messageId: msg.MessageId,
        receiptHandle: msg.ReceiptHandle,
        body: msg.Body ?? "",
        attributes: /** @type {import("aws-lambda").SQSRecordAttributes} */ (
          msg.Attributes || {}
        ),
        messageAttributes: {},
        md5OfBody: msg.MD5OfBody,
        eventSource: "aws:sqs",
        awsRegion: process.env.AWS_REGION ?? "us-east-1",
      },
    ],
  });
}

/**
 * DynamoDB Local does not emit Streams records. Poll pending durable outbox
 * items and pass them through the same dispatcher used by the deployed Stream
 * event source so local async workflows reach SQS too.
 */
const statusSeen = new Map();
let statusInitialized = false;
async function projectLocalStatus() {
  const endpoint = new URL(
    process.env.AWS_ENDPOINT_URL_DYNAMODB || "http://invalid",
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
    throw new Error(
      "Local status projection requires a loopback DynamoDB endpoint",
    );
  let cursor;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: getConfig().dynamoTable,
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of page.Items || []) {
      if (!statusRecords(item).length) continue;
      const key = JSON.stringify([item.pk, item.sk]),
        value = JSON.stringify(item);
      if (statusSeen.get(key) === value) continue;
      await projectStatus(item);
      statusSeen.set(key, value);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  if (!statusInitialized) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: getConfig().dynamoTable,
          Item: {
            pk: "SYSTEM#STATUS",
            sk: "#META",
            ready: true,
            trackingSince: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    }
    statusInitialized = true;
  }
}
async function dispatchPendingOutbox() {
  let lastEvaluatedKey;
  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: getConfig().dynamoTable,
        FilterExpression:
          "#status = :pending AND (#entityType = :revocation OR #entityType = :letter OR #entityType = :sf311)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#entityType": "entityType",
        },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":revocation": "REVOCATION_OUTBOX",
          ":letter": "COMPLIANCE_LETTER_OUTBOX",
          ":sf311": "SF311_OUTBOX",
        },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    for (const item of result.Items ?? []) {
      await dispatchOutbox(
        /** @type {import("aws-lambda").DynamoDBStreamEvent} */ ({
          Records: [
            {
              eventName: "INSERT",
              eventSource: "aws:dynamodb",
              dynamodb: { NewImage: marshall(item) },
            },
          ],
        }),
        /** @type {any} */ ({}),
        () => {},
      );
      console.log(`[worker] dispatched local outbox item ${item.sk}`);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
}

let lastExpirySweep = 0;
async function poll(queueUrl) {
  while (running) {
    try {
      if (Date.now() - lastExpirySweep > 60_000) {
        await expireComplianceTerms();
        lastExpirySweep = Date.now();
      }
      await projectLocalStatus();
      await dispatchPendingOutbox();
    } catch (err) {
      console.error(
        `[worker] local outbox dispatch failed, retrying on the next poll: ${summarizeError(err)}`,
      );
    }
    let received;
    try {
      received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          WaitTimeSeconds: 20, // long-poll (SQS max)
        }),
      );
    } catch (err) {
      if (!running) break;
      console.error("[worker] receive failed, retrying in 1s:", err);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    // Process the whole received batch CONCURRENTLY, mirroring the deployed
    // Lambda (src/lambda/worker.js). Each artifact's latency is almost entirely
    // its independent remote analyzer call, so a serial `for … await` here made
    // an N-photo check pay ~N× one call (visible as analyses landing one at a
    // time). Each message is still its own single-record event, so delete /
    // redelivery semantics per message are unchanged.
    await Promise.allSettled(
      (received.Messages ?? []).map(async (msg) => {
        try {
          const handler = pickHandler(msg.Body);
          const result = await handler(
            toSqsEvent(msg),
            /** @type {any} */ ({}),
            () => {},
          );
          const failed = result?.batchItemFailures?.some(
            (failure) => failure.itemIdentifier === msg.MessageId,
          );
          if (failed) {
            console.error(
              `[worker] handler reported failure for ${msg.MessageId}; leaving message for redelivery`,
            );
            return;
          }
          // Delete with THIS receive's ReceiptHandle, only on success.
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: msg.ReceiptHandle,
            }),
          );
          console.log(`[worker] processed & deleted ${msg.MessageId}`);
        } catch (err) {
          // Leave the message for redelivery (visibility timeout) — matches prod.
          console.error(
            `[worker] handler threw for ${msg.MessageId}: ${summarizeError(err)}`,
          );
        }
      }),
    );
  }
}

async function main() {
  const { queueUrl } = await ensureLocalInfra();
  console.log(`[worker] polling ${queueUrl}`);

  const stop = (signal) => {
    console.log(`[worker] ${signal} received, stopping after current poll…`);
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await poll(queueUrl);
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exit(1);
});
