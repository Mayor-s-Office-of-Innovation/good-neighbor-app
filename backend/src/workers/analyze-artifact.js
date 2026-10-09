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
import { getObjectBytes, setObjectTags } from "../s3.js";
import { downscaleImage, DownscaleError } from "../media/downscale.js";
import {
  AnalyzerError,
  createAnalyzerClient,
} from "../analysis/analyzer-client.js";
import { adaptAssessment } from "../analysis/adapt-scorecard.js";
import { getAnalyzerApiKey } from "../analysis/api-key.js";
import { analysisKey, checkHeaderKey } from "../handlers/keys.js";
import {
  enqueueTranslateArtifact,
  translateItemsFor,
} from "../analysis/translate-enqueue.js";
import { reverseGeocodePhoto } from "../integrations/reverse-geocoder.js";
import { elapsedMs, emitMetrics } from "../lib/metrics.js";

// Image types the analyzer accepts. MVP capture is images + optional text.
const ANALYZER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_OBJECT_BYTES = 10 * 1024 * 1024;

// The analyzer requires a `position_descriptor` ("where was this taken"). The
// perimeter check has no per-photo position (ADR 0014), and nothing downstream
// decides on the value — it is echoed back and lands on tasks as
// `source.positionDescriptor` — so every artifact sends this fixed literal.
export const POSITION_DESCRIPTOR = "perimeter";

/**
 * Evidence kind for the business metrics (observability plan Phase 2): a
 * message with an S3 key is a photo, anything else is a typed description.
 * Mirrors evidenceSummary in handlers/checks.js.
 * @param {Pick<AnalyzeMessage, "s3Key">} msg
 * @returns {"photo" | "text"}
 */
export function evidenceKindOf(msg) {
  return typeof msg.s3Key === "string" && msg.s3Key.length > 0
    ? "photo"
    : "text";
}

/**
 * Log-searchable ids every metric line carries (properties, never
 * dimensions — see lib/metrics.js).
 * @param {AnalyzeMessage} msg
 * @returns {{ siteId: string, checkId: string, artifactId: string }}
 */
function metricIds(msg) {
  return {
    siteId: msg.siteId,
    checkId: msg.checkId,
    artifactId: msg.artifactId,
  };
}

/**
 * @typedef {object} AnalyzeMessage
 * @property {string} siteId
 * @property {string} checkId
 * @property {string} artifactId
 * @property {string} [s3Key]
 * @property {string} [text] supplemental note captured with the photo
 * @property {string} [capturedAt] ISO-8601, this photo's capture time
 * @property {number} [latitude] device latitude at capture
 * @property {number} [longitude] device longitude at capture
 * @property {string} [language] the requester's locale, forwarded to the
 *   analyzer as its per-request `language` so model-written labels/descriptions
 *   also get translations the device can display
 */

/**
 * Build the analyzer request `metadata` for one photo. `metadata` is singular
 * per analyze call and this worker runs one call per artifact, so every field
 * here describes THIS photo, not the batch.
 * @param {AnalyzeMessage} msg
 * @returns {import("../analysis/analyzer-client.js").AnalyzeMetadata}
 */
function buildMetadata(msg) {
  const hasCoordinates =
    Number.isFinite(msg.latitude) && Number.isFinite(msg.longitude);
  return {
    position_descriptor: POSITION_DESCRIPTOR,
    reported_at: msg.capturedAt ?? new Date().toISOString(),
    // The analyzer contract requires numbers. Missing/declined device location
    // remains a deliberate 0,0 transport placeholder and is never copied into
    // task source data; 311 then falls back to the site's geocoded location.
    latitude: hasCoordinates ? Number(msg.latitude) : 0,
    longitude: hasCoordinates ? Number(msg.longitude) : 0,
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
    ...(Number.isFinite(msg.latitude) && Number.isFinite(msg.longitude)
      ? { latitude: msg.latitude, longitude: msg.longitude }
      : {}),
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
    return;
  }
  // Counted once, when the failure is first recorded (a redelivery that finds
  // the marker already present returns above and is not double-counted).
  emitMetrics({
    marker: "AnalysisFailed",
    dimensions: { Kind: evidenceKindOf(msg) },
    metrics: [{ name: "AnalysisFailed", value: 1 }],
    props: {
      ...metricIds(msg),
      reason:
        err.code ?? (err.status ? `http_${err.status}` : "analyzer_error"),
    },
  });
}

/**
 * Analyze one artifact end to end. Returns without effect when the ANALYSIS#
 * item already exists (redelivery), so it is safe to call repeatedly.
 * @param {AnalyzeMessage} msg
 * @param {object} deps
 * @param {import("../analysis/analyzer-client.js").AnalyzerClient} deps.client
 * @param {string} deps.dynamoTable
 * @param {string} deps.queueUrl where the follow-up translate message goes
 * @param {string} deps.uploadBucket
 * @param {boolean} deps.reverseGeocodingEnabled
 * @returns {Promise<void>}
 */
async function analyzeArtifact(
  msg,
  { client, dynamoTable, uploadBucket, queueUrl, reverseGeocodingEnabled },
) {
  /** @type {import("../analysis/analyzer-client.js").AnalyzeMedia[]} */
  const media = [];
  if (typeof msg.s3Key === "string" && msg.s3Key.length > 0) {
    // 1. Fetch the uploaded media (bytes only travel via the S3 key) + downscale.
    const object = await getObjectBytes({
      bucket: uploadBucket,
      key: msg.s3Key,
    });
    if (
      object.bytes.length > MAX_OBJECT_BYTES ||
      (object.contentLength ?? object.bytes.length) > MAX_OBJECT_BYTES
    ) {
      await setObjectTags({
        bucket: uploadBucket,
        key: msg.s3Key,
        tags: { state: "rejected" },
      });
      console.warn(
        JSON.stringify({
          marker: "MediaRejected",
          siteId: msg.siteId,
          checkId: msg.checkId,
          artifactId: msg.artifactId,
          reason: "input_too_large",
        }),
      );
      await markFailed({
        dynamoTable,
        msg,
        err: new AnalyzerError("Uploaded media exceeds the byte limit.", {
          code: "input_too_large",
        }),
      });
      return;
    }
    let downscaled;
    try {
      downscaled = await downscaleImage(
        object.bytes,
        object.contentType ?? "application/octet-stream",
      );
    } catch (err) {
      // Not a decodable image (corrupt/truncated/non-image bytes behind an
      // image content-type). Permanent — retrying can never succeed, so mark
      // the artifact failed rather than redelivering to the DLQ.
      if (!(err instanceof DownscaleError)) throw err;
      await setObjectTags({
        bucket: uploadBucket,
        key: msg.s3Key,
        tags: { state: "rejected" },
      });
      console.warn(
        JSON.stringify({
          marker: "MediaRejected",
          siteId: msg.siteId,
          checkId: msg.checkId,
          artifactId: msg.artifactId,
          reason: "undecodable_input",
        }),
      );
      await markFailed({
        dynamoTable,
        msg,
        err: new AnalyzerError(err.message, { code: "undecodable_input" }),
      });
      return;
    }
    const { bytes, contentType } = downscaled;
    await setObjectTags({
      bucket: uploadBucket,
      key: msg.s3Key,
      tags: { state: "accepted" },
    });

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

  // Start optional address lookup alongside the analyzer so it does not add
  // another network round trip to the skeleton-card wait. The catch is attached
  // immediately, including when the analyzer subsequently fails.
  const georeferencedAddressPromise =
    reverseGeocodingEnabled && msg.s3Key
      ? reverseGeocodePhoto(msg.latitude, msg.longitude).catch((err) => {
          console.warn("Photo reverse geocoding unavailable", {
            error: err instanceof Error ? err.name : "UnknownError",
          });
          return null;
        })
      : Promise.resolve(null);

  // 2. Call the analyzer. Permanent failures are marked and consumed; transient
  //    ones (retryable) throw so SQS redelivers, then dead-letters.
  const kind = evidenceKindOf(msg);
  const analyzeStartedAt = Date.now();
  let response;
  try {
    response = await client.analyze({
      metadata: buildMetadata(msg),
      media,
      requestId: `${msg.checkId}#${msg.artifactId}`,
      appId: "good-neighbor-app",
      ...(msg.language ? { language: msg.language } : {}),
    });
  } catch (err) {
    const permanent = err instanceof AnalyzerError && !err.retryable;
    // One AnalyzerLatencyMs sample per call regardless of outcome, so p95
    // reflects slow failures (timeouts) and not just the happy path.
    emitMetrics({
      marker: "AnalyzerCall",
      dimensions: { Kind: kind },
      metrics: [
        {
          name: "AnalyzerLatencyMs",
          value: elapsedMs(analyzeStartedAt),
          unit: "Milliseconds",
        },
        // Transient failures are counted here (they rethrow and redeliver);
        // permanent ones are counted by markFailed as AnalysisFailed.
        ...(permanent ? [] : [{ name: "AnalysisRetried", value: 1 }]),
      ],
      props: {
        ...metricIds(msg),
        outcome: permanent ? "permanent" : "retryable",
        reason:
          err instanceof AnalyzerError
            ? (err.code ?? (err.status ? `http_${err.status}` : "network"))
            : err instanceof Error
              ? err.name
              : "UnknownError",
      },
    });
    if (permanent) {
      await markFailed({
        dynamoTable,
        msg,
        err: /** @type {AnalyzerError} */ (err),
      });
      return;
    }
    throw err;
  }
  const analyzerLatencyMs = elapsedMs(analyzeStartedAt);

  const adapted = adaptAssessment(response);
  // A missing or failed lookup is a normal fallback to the site's address.
  const georeferencedAddress = await georeferencedAddressPromise;

  // 3. Persist the per-artifact analysis. The conditional write is the
  //    idempotency gate for redelivery — EXCEPT that a re-driven artifact (a
  //    client retry re-registers the same artifactId, which re-enqueues) must
  //    be able to replace an earlier `status:"failed"` marker: otherwise the
  //    failed marker would permanently occupy the ANALYSIS# slot and every
  //    retry would re-read the old failure. Success overwrites failure only;
  //    a redelivery of an already-analyzed artifact still stops here.
  const item = {
    ...analysisKey(msg.siteId, msg.checkId, msg.artifactId),
    checkId: msg.checkId,
    artifactId: msg.artifactId,
    ...(msg.capturedAt ? { capturedAt: msg.capturedAt } : {}),
    ...(Number.isFinite(msg.latitude) && Number.isFinite(msg.longitude)
      ? { latitude: msg.latitude, longitude: msg.longitude }
      : {}),
    ...(georeferencedAddress ? { georeferencedAddress } : {}),
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
        // Fresh slot, OR the slot holds a failed marker (retry recovery).
        // NOT an existing success: a redelivered message must never double-
        // write (it would re-stamp analyzedAt and re-run the counters).
        ConditionExpression: "attribute_not_exists(sk) OR #st = :failed",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":failed": "failed" },
      }),
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // Redelivery: already analyzed. Don't double-count the counters.
      emitMetrics({
        marker: "AnalysisDuplicate",
        dimensions: { Kind: kind },
        metrics: [{ name: "AnalysisDuplicate", value: 1 }],
        props: metricIds(msg),
      });
      return;
    }
    throw err;
  }
  emitMetrics({
    marker: "AnalysisCompleted",
    dimensions: { Kind: kind },
    metrics: [
      { name: "AnalysisCompleted", value: 1 },
      {
        name: "AnalyzerLatencyMs",
        value: analyzerLatencyMs,
        unit: "Milliseconds",
      },
    ],
    props: { ...metricIds(msg), grade: adapted.grade },
  });

  // 4. Hand the model-written text to the background translate worker so the
  //    locales the analyze call did not produce fill in (best-effort: a lost
  //    enqueue leaves English, never fails an analysis that just landed).
  try {
    await enqueueTranslateArtifact({
      queueUrl,
      siteId: msg.siteId,
      checkId: msg.checkId,
      artifactId: msg.artifactId,
      items: translateItemsFor(adapted.concerns),
    });
  } catch (err) {
    console.warn("Translate enqueue failed; analysis keeps English only", {
      checkId: msg.checkId,
      artifactId: msg.artifactId,
      error: err instanceof Error ? err.name : "UnknownError",
    });
  }

  // 5. Nudge the header's in-progress counters (best-effort).
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
  const {
    dynamoTable,
    uploadBucket,
    queueUrl,
    analyzerBaseUrl,
    reverseGeocodingEnabled,
  } = getConfig();
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
      await analyzeArtifact(msg, {
        client,
        dynamoTable,
        uploadBucket,
        queueUrl,
        reverseGeocodingEnabled: reverseGeocodingEnabled === true,
      });
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
