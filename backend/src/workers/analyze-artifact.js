// Analyze worker: the async half of the perimeter-check media path. For each
// enqueued artifact it reads the uploaded media from S3, downscales it (seam),
// base64-encodes it, calls the Street Conditions analyzer, and persists the
// adapted per-artifact scorecard as an ANALYSIS# item — then nudges the CHECK
// header's running counters. `completeCheck` (C4) does the authoritative
// roll-up; the counters here are a best-effort in-progress display.
//
// Invariants (see security-review.md, media-handling):
//   - Media bytes reach this worker only via the S3 key on the message — never
//     through the queue body — and are never logged.
//   - The analyzer API key is server-side (api-key.js) and `store_input:false`
//     is stamped by the client, so the analyzer never retains our media.
//   - Idempotent: the ANALYSIS# write is conditional on the sort key, so a
//     redelivered message can't create a second analysis or double-count.

import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { getObjectBytes } from "../s3.js";
import { downscaleImage } from "../media/downscale.js";
import {
  AnalyzerError,
  createAnalyzerClient,
} from "../analysis/analyzer-client.js";
import { adaptAssessment } from "../analysis/adapt-scorecard.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import { analysisKey, checkHeaderKey } from "../handlers/keys.js";

// Image types the analyzer accepts. MVP capture is images + optional text.
const ANALYZER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * @typedef {object} AnalyzeMessage
 * @property {string} siteId
 * @property {string} checkId
 * @property {string} artifactId
 * @property {string} [s3Key]
 * @property {string} [side]
 * @property {string} [text] supplemental note captured with the photo
 * @property {string} [capturedAt] ISO-8601, this photo's capture time
 */

/**
 * Build the analyzer request `metadata` for one photo. `metadata` is singular
 * per analyze call and this worker runs one call per artifact, so every field
 * here describes THIS photo, not the batch.
 * @param {AnalyzeMessage} msg
 * @returns {import("../analysis/analyzer-client.js").AnalyzeMetadata}
 */
function buildMetadata(msg) {
  return {
    position_descriptor: msg.side ?? "perimeter",
    reported_at: msg.capturedAt ?? new Date().toISOString(),
    // TODO(product): real per-photo GPS. Read device coordinates AT THE MOMENT
    // EACH PHOTO IS CAPTURED (not at check start or batch submit) and stamp
    // them on the artifact so these are the true location of this photo.
    // Pending the v1 capture-flow UI (per-photo GPS is a deferred follow-up);
    // 0,0 placeholder until then.
    latitude: 0,
    longitude: 0,
  };
}

/**
 * Nudge the CHECK header's in-progress counters after one artifact analyzes.
 * Best-effort only — `completeCheck` recomputes the authoritative roll-up from
 * every ANALYSIS# item — so a missing header (already completed/deleted) is
 * swallowed rather than dead-lettering an artifact that did analyze cleanly.
 * `issueCount` sums (the conditional ANALYSIS# write guarantees we reach here
 * at most once per artifact); `maxSeverity` is a running max, which DynamoDB
 * can't express in one update, so we raise it only when this photo exceeds the
 * current value and tolerate the no-op rejection.
 * @param {object} params
 * @param {string} params.dynamoTable
 * @param {string} params.siteId
 * @param {string} params.checkId
 * @param {number} params.incIssues
 * @param {number} params.maxSeverity
 * @returns {Promise<void>}
 */
async function bumpHeaderCounters({
  dynamoTable,
  siteId,
  checkId,
  incIssues,
  maxSeverity,
}) {
  const key = checkHeaderKey(siteId, checkId);
  try {
    if (incIssues > 0) {
      await ddb.send(
        new UpdateCommand({
          TableName: dynamoTable,
          Key: key,
          UpdateExpression: "ADD issueCount :inc",
          ConditionExpression: "attribute_exists(sk)",
          ExpressionAttributeValues: { ":inc": incIssues },
        }),
      );
    }
    if (maxSeverity > 0) {
      await ddb.send(
        new UpdateCommand({
          TableName: dynamoTable,
          Key: key,
          UpdateExpression: "SET maxSeverity = :sev",
          ConditionExpression: "attribute_exists(sk) AND maxSeverity < :sev",
          ExpressionAttributeValues: { ":sev": maxSeverity },
        }),
      );
    }
  } catch (err) {
    // maxSeverity already >= this photo's, or the header is gone. Either way the
    // authoritative counts land at complete; nothing to retry here.
    if (
      !(err instanceof Error && err.name === "ConditionalCheckFailedException")
    ) {
      throw err;
    }
  }
}

/**
 * Record a permanent (non-retryable) analyzer failure as an ANALYSIS# marker so
 * the artifact is accounted for and the message isn't retried forever. The
 * marker carries no `concerns`/`grade`, so `completeCheck` excludes it from
 * synthesis while `getCheck` can still surface that this photo failed.
 * @param {object} params
 * @param {string} params.dynamoTable
 * @param {AnalyzeMessage} params.msg
 * @param {AnalyzerError} params.err
 * @returns {Promise<void>}
 */
async function markFailed({ dynamoTable, msg, err }) {
  const item = {
    ...analysisKey(msg.siteId, msg.checkId, msg.artifactId),
    checkId: msg.checkId,
    artifactId: msg.artifactId,
    ...(msg.side ? { side: msg.side } : {}),
    status: "failed",
    error: {
      ...(err.code ? { code: err.code } : {}),
      ...(err.status ? { status: err.status } : {}),
      message: err.message,
    },
    analyzedAt: new Date().toISOString(),
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: dynamoTable,
        Item: item,
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  } catch (putErr) {
    // Already recorded (success or a prior failure marker) — nothing to do.
    if (
      !(
        putErr instanceof Error &&
        putErr.name === "ConditionalCheckFailedException"
      )
    ) {
      throw putErr;
    }
  }
}

/**
 * Analyze one artifact end to end. Returns without effect when the ANALYSIS#
 * item already exists (redelivery), so it is safe to call repeatedly.
 * @param {AnalyzeMessage} msg
 * @param {object} deps
 * @param {import("../analysis/analyzer-client.js").AnalyzerClient} deps.client
 * @param {string} deps.dynamoTable
 * @param {string} deps.uploadBucket
 * @returns {Promise<void>}
 */
async function analyzeArtifact(msg, { client, dynamoTable, uploadBucket }) {
  /** @type {import("../analysis/analyzer-client.js").AnalyzeMedia[]} */
  const media = [];
  if (typeof msg.s3Key === "string" && msg.s3Key.length > 0) {
    // 1. Fetch the uploaded media (bytes only travel via the S3 key) + downscale.
    const object = await getObjectBytes({
      bucket: uploadBucket,
      key: msg.s3Key,
    });
    const { bytes, contentType } = await downscaleImage(
      object.bytes,
      object.contentType ?? "application/octet-stream",
    );

    if (!ANALYZER_IMAGE_TYPES.has(contentType)) {
      // A key that isn't one of our accepted image types can never analyze —
      // treat it as a permanent failure rather than retry forever.
      await markFailed({
        dynamoTable,
        msg,
        err: new AnalyzerError(
          `Unsupported media content-type: ${contentType}`,
          {
            code: "unsupported_input_type",
          },
        ),
      });
      return;
    }

    media.push(
      /** @type {import("../analysis/analyzer-client.js").ImageMedia} */ ({
        type: "image",
        content_type: contentType,
        base64: bytes.toString("base64"),
      }),
    );
  }
  if (typeof msg.text === "string" && msg.text.length > 0) {
    media.push({ type: "text", text: msg.text });
  }
  if (media.length === 0) {
    await markFailed({
      dynamoTable,
      msg,
      err: new AnalyzerError("Artifact contained neither image nor text.", {
        code: "invalid_request",
      }),
    });
    return;
  }

  // 2. Call the analyzer. Permanent failures are marked and consumed; transient
  //    ones (retryable) throw so SQS redelivers, then dead-letters.
  let response;
  try {
    response = await client.analyze({
      metadata: buildMetadata(msg),
      media,
      requestId: `${msg.checkId}#${msg.artifactId}`,
      appId: "good-neighbor-app",
    });
  } catch (err) {
    if (err instanceof AnalyzerError && !err.retryable) {
      await markFailed({ dynamoTable, msg, err });
      return;
    }
    throw err;
  }

  const adapted = adaptAssessment(response);

  // 3. Persist the per-artifact analysis. The conditional write is the
  //    idempotency gate: a redelivery finds the item already there and stops
  //    before touching the counters.
  const item = {
    ...analysisKey(msg.siteId, msg.checkId, msg.artifactId),
    checkId: msg.checkId,
    artifactId: msg.artifactId,
    ...(msg.side ? { side: msg.side } : {}),
    status: "analyzed",
    analysisId: adapted.analysisId,
    rubricVersion: adapted.rubricVersion,
    model: adapted.model,
    grade: adapted.grade,
    gradeDescription: adapted.gradeDescription,
    concerns: adapted.concerns,
    issueCount: adapted.issueCount,
    maxSeverity: adapted.maxSeverity,
    analyzedAt: new Date().toISOString(),
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: dynamoTable,
        Item: item,
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // Redelivery: already analyzed. Don't double-count the counters.
      return;
    }
    throw err;
  }

  // 4. Nudge the header's in-progress counters (best-effort).
  await bumpHeaderCounters({
    dynamoTable,
    siteId: msg.siteId,
    checkId: msg.checkId,
    incIssues: adapted.issueCount,
    maxSeverity: adapted.maxSeverity,
  });
}

/**
 * SQS entry point. Builds the analyzer client once per batch, then analyzes
 * every record in the batch CONCURRENTLY (each artifact is an independent remote
 * call whose latency is all in the analyzer's response, so batch wall-clock ≈ the
 * slowest single call, not the sum). Failures are isolated per message via a
 * partial-batch response — only the rejected artifacts redeliver, never the whole
 * batch. Permanent analyzer failures are consumed via a failure marker inside
 * `analyzeArtifact` and never surface here.
 * @type {import("aws-lambda").SQSHandler}
 */
export const handler = async (event) => {
  const { dynamoTable, uploadBucket, analyzerBaseUrl } = getConfig();
  if (!analyzerBaseUrl) {
    throw new Error(
      "Missing required environment variable ANALYZER_BASE_URL for the analyze worker",
    );
  }
  const apiKey = await getAnalyzerApiKey();
  // Retries disabled (maxRetries: 0): one analyzer call per artifact, no hidden
  // exponential backoff. A transient failure surfaces as a rejected promise below
  // and redelivers via SQS, rather than being masked (and re-timed) in-process.
  const client = createAnalyzerClient({
    baseUrl: analyzerBaseUrl,
    apiKey,
    maxRetries: 0,
  });

  // Fan out: fire every artifact's analysis at once and await them together.
  const settled = await Promise.allSettled(
    event.Records.map(async (record) => {
      const msg = /** @type {AnalyzeMessage} */ (JSON.parse(record.body));
      await analyzeArtifact(msg, { client, dynamoTable, uploadBucket });
    }),
  );

  // Report only the failed messages back to SQS (the event source mapping sets
  // function_response_types = ["ReportBatchItemFailures"]). Succeeded artifacts
  // are acknowledged and never re-analyzed; only the rejected ones redeliver.
  /** @type {{ itemIdentifier: string }[]} */
  const batchItemFailures = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      const { messageId } = event.Records[index];
      console.error("analyzeArtifact failed; message will redeliver", {
        messageId,
        error: result.reason,
      });
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  });

  return { batchItemFailures };
};
