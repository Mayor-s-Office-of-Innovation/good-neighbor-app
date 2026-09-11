// Forward a scrubbed feedback submission to PostHog as a `survey sent` event
// (docs/runbooks/feedback-ops.md). PostHog is the feedback store — the
// CloudWatch log line carries metadata only (no message text; text was
// removed from logging when PostHog became the destination). Kept mechanical
// like forwarder.js so provider swaps stay trivial. All forwarding is
// best-effort: failures become WARN log lines and the caller still returns
// 204 — a tracker outage must never create app errors.
//
// Log-only mode: when no ingest key is resolvable OR either survey ID is
// unset, nothing egresses. This is the pre-config default, the local-dev
// behavior, and the kill switch (unset a survey ID to revoke). See
// posthog-api-key.js for key resolution semantics.

import { getConfig } from "../config.js";
import { getPosthogApiKey } from "./posthog-api-key.js";

const DEFAULT_HOST = "https://us.i.posthog.com";

/** The log marker CloudWatch metric filters + alarms key on. */
export const FORWARD_FAILED_MARKER = "FeedbackForwardFailed";
const LOG_ONLY_MARKER = "FeedbackLogOnly";

/**
 * Server-side distinct_id fallback. The scrubber requires `id`, so this only
 * fires for a hand-constructed ScrubbedFeedback that skipped it — belt and
 * suspenders: an event without a distinct_id would be rejected by the PostHog
 * ingest and the feedback lost.
 */
const FALLBACK_DISTINCT_ID = "feedback-anonymous";

/**
 * Forward a scrubbed feedback submission to PostHog. Never throws.
 * @param {import("./scrub-feedback.js").ScrubbedFeedback} feedback
 * @param {{ userAgent?: string }} ctx best taken from the API Gateway event
 *   headers server-side; the client never sends it
 * @param {{ fetchImpl?: typeof fetch, host?: string, now?: () => number,
 *   config?: import("../config.js").AppConfig }} [deps] test seams; `config`
 *   defaults to getConfig() (the Lambda env)
 * @returns {Promise<"forwarded" | "log-only" | "failed">}
 */
export async function forwardFeedback(feedback, ctx, deps = {}) {
  const config = deps.config ?? getConfig();

  // Survey IDs are plain identifiers (not secrets) but are required together:
  // without both, the response event can't be shaped — quiet log-only.
  if (!config.posthogFeedbackSurveyId || !config.posthogFeedbackQuestionId) {
    logOnly(feedback);
    return "log-only";
  }

  let apiKey;
  try {
    apiKey = await getPosthogApiKey(config);
  } catch (err) {
    warnForwardFailed("secret_fetch_failed", err);
    return "failed";
  }
  if (!apiKey) {
    logOnly(feedback);
    return "log-only";
  }

  const host = deps.host || process.env.POSTHOG_HOST || DEFAULT_HOST;
  const ts = toIso(feedback.ts);
  const event = {
    event: "survey sent",
    distinct_id: feedback.id || FALLBACK_DISTINCT_ID,
    properties: {
      $survey_id: config.posthogFeedbackSurveyId,
      [`$survey_response_${config.posthogFeedbackQuestionId}`]: feedback.text,
      ...(feedback.page ? { app_source: feedback.page } : {}),
      ...(feedback.site ? { site: feedback.site } : {}),
      ...(feedback.release ? { release: feedback.release } : {}),
      ...(ctx.userAgent ? { user_agent: ctx.userAgent } : {}),
      $process_person_profile: false,
    },
    ...(ts ? { timestamp: ts } : {}),
  };

  const body = {
    api_key: apiKey,
    batch: [event],
    ...(ts ? { sentAt: new Date((deps.now ?? Date.now)()).toISOString() } : {}),
  };

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await withTimeout(
      fetchImpl(`${host}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) {
      throw new Error(`PostHog ingest returned ${res.status}`);
    }
    return "forwarded";
  } catch (err) {
    warnForwardFailed("forward_failed", err);
    return "failed";
  }
}

/**
 * Log-only mode: the intake pipeline runs end-to-end minus egress.
 * @param {import("./scrub-feedback.js").ScrubbedFeedback} feedback
 */
function logOnly(feedback) {
  console.log(
    JSON.stringify({
      level: "info",
      marker: LOG_ONLY_MARKER,
      textLength: feedback.text.length,
    }),
  );
}

/**
 * Accept an ISO-ish client timestamp only if parseable; otherwise omit and let
 * intake time apply server-side.
 * @param {string | undefined} ts
 * @returns {string | undefined}
 */
export function toIso(ts) {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * @param {string} reason
 * @param {unknown} err
 */
function warnForwardFailed(reason, err) {
  console.warn(
    JSON.stringify({
      level: "warn",
      marker: FORWARD_FAILED_MARKER,
      reason,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * Reject with a timeout error if the fetch doesn't settle in time.
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
async function withTimeout(promise) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("forwarder timeout")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
