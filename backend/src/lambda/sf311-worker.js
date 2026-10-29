import {
  handler as runJobs,
  MAX_FILING_ATTEMPTS,
} from "../workers/sf311-job.js";
import { reportSf311Failure } from "../integrations/sf311-observability.js";

/**
 * Dedicated entrypoint; partial failures preserve successful records in a batch.
 * @param {import("aws-lambda").SQSEvent} event
 * @returns {Promise<import("aws-lambda").SQSBatchResponse>}
 */
export async function handler(event) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    let valid = false;
    try {
      valid = JSON.parse(record.body)?.type === "sf311_job";
      if (!valid) throw new Error("Invalid 311 job type");
      await runJobs(
        { Records: [record] },
        /** @type {import("aws-lambda").Context} */ ({}),
        () => {},
      );
    } catch {
      if (!valid)
        reportSf311Failure("job", "invalid_job", {
          terminal:
            Number(record.attributes?.ApproximateReceiveCount) >=
            MAX_FILING_ATTEMPTS,
          messageId: record.messageId,
        });
      // runJobs logs safe failure context and sets the bounded retry delay.
      // Never serialize the original error or message body here.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
