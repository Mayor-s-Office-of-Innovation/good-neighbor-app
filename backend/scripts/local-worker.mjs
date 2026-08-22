// SQS → worker pump — the local stand-in for the Lambda event source mapping.
// Long-polls ElasticMQ, wraps each message in an SQSEvent, invokes the SAME
// exported worker handler we deploy, and deletes the message only after the
// handler succeeds (so a throw leaves it for redelivery, like real SQS).

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { ensureLocalInfra } from "./lib/ensure-infra.mjs";
import { handler as processSubmission } from "../src/workers/process-submission.js";
import { handler as analyzeArtifact } from "../src/workers/analyze-artifact.js";

const sqs = new SQSClient({});
let running = true;

/**
 * Both flows share SQS_QUEUE_URL, so the local pump — standing in for two
 * separate Lambda event-source mappings — picks the handler by message shape.
 * The register handler enqueues an analyze message carrying s3Key + artifactId;
 * the demo /submissions flow does not. Anything without both goes to the
 * submission handler (unchanged default).
 * @param {string | undefined} body
 * @returns {import("aws-lambda").SQSHandler}
 */
function pickHandler(body) {
  try {
    const msg = JSON.parse(body ?? "");
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
        attributes: {},
        messageAttributes: {},
        md5OfBody: msg.MD5OfBody,
        eventSource: "aws:sqs",
        awsRegion: process.env.AWS_REGION ?? "us-east-1",
      },
    ],
  });
}

async function poll(queueUrl) {
  while (running) {
    let received;
    try {
      received = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // long-poll (SQS max)
        }),
      );
    } catch (err) {
      if (!running) break;
      console.error("[worker] receive failed, retrying in 1s:", err);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    for (const msg of received.Messages ?? []) {
      try {
        const handler = pickHandler(msg.Body);
        await handler(toSqsEvent(msg), /** @type {any} */ ({}), () => {});
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
        console.error(`[worker] handler threw for ${msg.MessageId}:`, err);
      }
    }
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
