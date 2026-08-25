// SQS event-source entrypoint for the async worker. Both the demo /submissions
// flow and the per-artifact analyze flow share one queue (and so, one worker
// Lambda), exactly as the local pump does — see `scripts/local-worker.mjs`. We
// pick the underlying handler by message shape, process records one at a time,
// and return `batchItemFailures` so only the messages that actually threw get
// redriven (partial-batch-failure reporting; requires the event-source mapping's
// `function_response_types = ["ReportBatchItemFailures"]`).

import { handler as processSubmission } from "../workers/process-submission.js";
import { handler as analyzeArtifact } from "../workers/analyze-artifact.js";

/**
 * Pick the worker for a message by its shape (mirrors local-worker.mjs
 * `pickHandler`). The register handler enqueues an analyze message carrying
 * `artifactId` plus either `s3Key` (photo) or `text` (description); the demo
 * /submissions flow carries neither. Anything without an artifact goes to the
 * submission handler.
 * @param {string | undefined} body
 * @returns {import("aws-lambda").SQSHandler}
 */
function pickHandler(body) {
  try {
    const msg = JSON.parse(body ?? "");
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
 * @type {import("aws-lambda").SQSHandler}
 */
export const handler = async (event, context, callback) => {
  // Fan out: each record is an independent unit of work whose latency is almost
  // entirely the remote analyzer call, so process the whole batch CONCURRENTLY and
  // await it together — batch wall-clock ≈ the slowest record, not the sum.
  // (This loop previously awaited each record in series, which serialized the
  // per-artifact analyzer calls: a 3-photo check paid ~3× one ~11s call ≈ 33s.)
  const settled = await Promise.allSettled(
    event.Records.map((record) => {
      const fn = pickHandler(record.body);
      return fn(
        /** @type {import("aws-lambda").SQSEvent} */ ({ Records: [record] }),
        context,
        callback,
      );
    }),
  );

  // Report only the records that threw (partial-batch-failure); the rest are
  // acknowledged and never redelivered. Requires the event-source mapping's
  // `function_response_types = ["ReportBatchItemFailures"]`.
  /** @type {{ itemIdentifier: string }[]} */
  const batchItemFailures = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      const { messageId } = event.Records[index];
      console.error(`[worker] record ${messageId} failed:`, result.reason);
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  });

  return { batchItemFailures };
};
