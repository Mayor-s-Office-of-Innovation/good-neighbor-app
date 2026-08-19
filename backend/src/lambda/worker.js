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
 * `s3Key` + `artifactId`; the demo /submissions flow does not. Anything without
 * both goes to the submission handler.
 * @param {string | undefined} body
 * @returns {import("aws-lambda").SQSHandler}
 */
function pickHandler(body) {
  try {
    const msg = JSON.parse(body ?? "");
    if (typeof msg?.s3Key === "string" && typeof msg?.artifactId === "string") {
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
  /** @type {{ itemIdentifier: string }[]} */
  const batchItemFailures = [];

  for (const record of event.Records) {
    const fn = pickHandler(record.body);
    try {
      await fn(
        /** @type {import("aws-lambda").SQSEvent} */ ({ Records: [record] }),
        context,
        callback,
      );
    } catch (err) {
      console.error(`[worker] record ${record.messageId} failed:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
