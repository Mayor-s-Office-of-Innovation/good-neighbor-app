/*
 * POST /v1/feedback — public, unauthenticated intake for in-app user
 * feedback (see docs/todo/feedback-plan.md). Contract: always respond 204,
 * never throw, never signal payload validity to a possible abuser. Valid
 * submissions are scrubbed (allowlist-only), logged as one metadata-only
 * structured JSON line (no message text — PostHog is the feedback store; the
 * CloudWatch leg is operational signals + fallback only), and forwarded to
 * PostHog as a `survey sent` event (log-only until key + survey IDs are
 * configured — see feedback-forwarder.js).
 */

import { readJsonBody } from "../http.js";
import { scrubFeedback } from "./scrub-feedback.js";
import { forwardFeedback } from "./feedback-forwarder.js";

/*
 * Log markers: FeedbackReceived counts as the feedback-arrival metric
 * (alarms.tf filter → SNS email); FeedbackDropped is the quiet-but-counted
 * abuse/validation signal (silent drops would hide exactly what we alarm on).
 * Neither line ever carries the message text.
 */
export const RECEIVED_MARKER = "FeedbackReceived";
export const DROPPED_MARKER = "FeedbackDropped";

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const handler = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    body = undefined;
  }

  const feedback = scrubFeedback(body);
  if (!feedback) {
    // Drop garbage quietly but observably: one compact JSON line so the
    // FeedbackDropped metric filter has something to count.
    console.warn(
      JSON.stringify({
        level: "warn",
        marker: DROPPED_MARKER,
        reason: "invalid_payload",
      }),
    );
    return { statusCode: 204 };
  }

  // Metadata-only arrival line (operational signal; deliberately no `text` —
  // CloudWatch does not store feedback content, PostHog does).
  console.log(
    JSON.stringify({
      level: "info",
      marker: RECEIVED_MARKER,
      ts: new Date().toISOString(),
      ...("page" in feedback ? { page: feedback.page } : {}),
      ...("site" in feedback ? { site: feedback.site } : {}),
      ...("release" in feedback ? { release: feedback.release } : {}),
      ...("id" in feedback ? { id: feedback.id } : {}),
      userAgent: readUserAgent(event),
      textLength: feedback.text.length,
    }),
  );

  // Best-effort forward to the feedback store (PostHog). Never throws; the
  // outcome only affects WARN lines, never the response.
  try {
    await forwardFeedback(feedback, { userAgent: readUserAgent(event) });
  } catch {
    // forwardFeedback never throws, but a surprise here must not 500 the
    // intake either — the submission is already durably counted above.
  }

  // Always 204 No Content — validity is never signalled back.
  return { statusCode: 204 };
};

/**
 * Read the caller's user-agent header (any casing) to attach to the log line.
 * @param {unknown} event
 * @returns {string | undefined}
 */
function readUserAgent(event) {
  try {
    const headers =
      /** @type {Record<string, string | undefined> | undefined} */ (
        /** @type {any} */ (event)?.headers
      );
    if (!headers) return undefined;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "user-agent") {
        const ua = headers[key];
        return typeof ua === "string" ? ua : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}