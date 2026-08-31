// Forward a scrubbed client error report to PostHog as a `$exception` event.
// Kept deliberately mechanical so provider swaps stay trivial. All forwarding
// is best-effort: failures become WARN log lines and the caller still returns
// 204 — an error-tracker outage must never create app errors.
//
// Log-only mode (the pre-sign-off default): when no key is resolvable, reports
// are validated + logged but never egress. See posthog-api-key.js for the
// secret resolution semantics.

import { getConfig } from "../config.js";
import { getPosthogApiKey } from "./posthog-api-key.js";

const DEFAULT_HOST = "https://us.i.posthog.com";

/** The log marker CloudWatch metric filters + alarms key on. */
export const FORWARD_FAILED_MARKER = "ClientErrorForwardFailed";
const LOG_ONLY_MARKER = "ClientErrorLogOnly";

/**
 * Forward a scrubbed client error report to PostHog. Never throws.
 * @param {import("./scrub-client-error.js").ScrubbedErrorReport} report
 * @param {{ userAgent?: string }} ctx best taken from the API Gateway event
 *   headers server-side; the client never sends it
 * @param {{ fetchImpl?: typeof fetch, host?: string, now?: () => number,
 *   config?: import("../config.js").AppConfig }} [deps] test seams; `config`
 *   defaults to getConfig() (the Lambda env)
 * @returns {Promise<"forwarded" | "log-only" | "failed">}
 */
export async function forwardClientError(report, ctx, deps = {}) {
  let apiKey;
  try {
    apiKey = await getPosthogApiKey(deps.config ?? getConfig());
  } catch (err) {
    warnForwardFailed("secret_fetch_failed", err);
    return "failed";
  }

  if (!apiKey) {
    // Log-only mode: the pipeline runs end-to-end minus egress.
    console.log(
      JSON.stringify({
        level: "info",
        marker: LOG_ONLY_MARKER,
        type: report.type,
        message: report.message,
      }),
    );
    return "log-only";
  }

  const host = deps.host || process.env.POSTHOG_HOST || DEFAULT_HOST;
  const ts = toIso(report.ts);
  const event = {
    event: "$exception",
    distinct_id: report.id,
    properties: {
      $exception_type: report.type,
      $exception_message: report.message,
      ...(report.stack ? { $exception_stack_trace: report.stack } : {}),
      $exception_handling: "unhandled",
      ...(report.release ? { release: report.release } : {}),
      ...(report.source ? { app_source: report.source } : {}),
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
