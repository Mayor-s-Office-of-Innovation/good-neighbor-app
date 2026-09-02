// Forward a scrubbed client error report to PostHog as a `$exception` event.
// Kept deliberately mechanical so provider swaps stay trivial. All forwarding
// is best-effort: failures become WARN log lines and the caller still returns
// 204 — an error-tracker outage must never create app errors.
//
// Log-only mode (the pre-sign-off default): when no key is resolvable, reports
// are validated + logged but never egress. See posthog-api-key.js for the
// secret resolution semantics.
//
// Event shape: PostHog's `$exception` schema is strict — manual captures must
// carry a structured `$exception_list` (type/value/stacktrace frames/
// mechanism); the legacy flat `$exception_type`/`$exception_message`/
// `$exception_stack_trace` properties are NOT normalized by ingestion and do
// not enter Error Tracking reliably. The stack string is parsed into frames
// here (V8 + Firefox line formats) so exceptions group into issues and
// symbolicate against the uploaded source maps.

import { getConfig } from "../config.js";
import { getPosthogApiKey } from "./posthog-api-key.js";

const DEFAULT_HOST = "https://us.i.posthog.com";

/** The log marker CloudWatch metric filters + alarms key on. */
export const FORWARD_FAILED_MARKER = "ClientErrorForwardFailed";
/** Marker for successfully forwarded reports (per-report INFO line). */
export const FORWARD_OK_MARKER = "ClientErrorForwarded";
const LOG_ONLY_MARKER = "ClientErrorLogOnly";

/**
 * One parsed stack frame, shaped for `$exception_list[].stacktrace.frames`
 * (Sentry-compatible: posthog-js sends the same keys).
 * @typedef {object} PosthogFrame
 * @property {string} [filename]
 * @property {number} [lineno]
 * @property {number} [colno]
 * @property {string} [function] -- quoted: "function" is a reserved word
 */

/**
 * The strict per-exception entry PostHog Error Tracking ingests.
 * @typedef {object} PosthogException
 * @property {string} type
 * @property {string} value
 * @property {{ frames: PosthogFrame[] }} stacktrace
 * @property {{ handled: boolean, synthetic: boolean }} mechanism
 */

/**
 * Parse a JS stack string into PostHog frame objects. Handles V8
 * (`    at fn (url:1:2)` / `    at url:1:2`) and Firefox/Safari
 * (`fn@url:1:2`) shapes; the leading message line and unparseable lines are
 * skipped. Frames are reversed so index 0 is the outermost call and the last
 * frame is the throw site — the convention posthog-js/Sentry use.
 * @param {string} stack
 * @returns {PosthogFrame[]}
 */
export function parseStackFrames(stack) {
  /** @type {PosthogFrame[]} */
  const frames = [];
  for (const line of stack.split("\n")) {
    const v8 = line.match(/^\s*at\s+(.*)$/);
    const ff = v8 ? undefined : line.match(/^(.+?)@(.*)$/);
    if (!v8 && !ff) continue; // message line / blank — not a frame
    const rest = (v8?.[1] ?? line).trim();

    /** @type {string | undefined} */
    let fn;
    /** @type {string | undefined} */
    let loc;
    if (v8) {
      const paren = rest.match(/^(.*?)\s*\((.*)\)\s*$/);
      if (paren) {
        fn = paren[1] || undefined;
        loc = paren[2];
      } else {
        loc = rest;
      }
    } else if (ff) {
      fn = ff[1] || undefined;
      loc = ff[2];
    }

    /** @type {PosthogFrame} */
    const frame = {};
    const pos = loc?.match(/^(.*):(\d+):(\d+)$/);
    if (pos && pos[1] && pos[1] !== "<anonymous>") {
      frame.filename = pos[1];
      frame.lineno = Number(pos[2]);
      frame.colno = Number(pos[3]);
    } else if (loc && loc !== "<anonymous>") {
      frame.filename = loc;
    }
    if (fn) frame["function"] = fn.trimEnd();
    if (frame.filename || frame["function"]) frames.push(frame);
  }
  return frames.reverse();
}

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
    warnForwardFailed("secret_fetch_failed", err, report);
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
  /** @type {PosthogException} */
  const exception = {
    type: report.type,
    value: report.message,
    stacktrace: { frames: report.stack ? parseStackFrames(report.stack) : [] },
    mechanism: { handled: false, synthetic: true },
  };
  const event = {
    event: "$exception",
    distinct_id: report.id,
    properties: {
      $exception_list: [exception],
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
    ...(ts
      ? { sent_at: new Date((deps.now ?? Date.now)()).toISOString() }
      : {}),
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
    // Dual storage: every accepted report gets an INFO line in CloudWatch
    // (per the error-tracking plan), not just the log-only path.
    console.log(
      JSON.stringify({
        level: "info",
        marker: FORWARD_OK_MARKER,
        type: report.type,
        message: report.message,
      }),
    );
    return "forwarded";
  } catch (err) {
    warnForwardFailed("forward_failed", err, report);
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
 * Log the failure WARN. The scrubbed report's type/message ride along so the
 * error is retained in CloudWatch even when PostHog never accepts it (the
 * success INFO line wouldn't exist) — dual storage must hold on failure too.
 * The report is already scrubbed + size-capped by the intake, so echoing it is
 * safe. Stack is omitted: it's the one field that can still embed sensitive
 * strings from code/messages, and failure triage needs type+message only.
 * @param {string} reason
 * @param {unknown} err
 * @param {import("./scrub-client-error.js").ScrubbedErrorReport} report
 */
function warnForwardFailed(reason, err, report) {
  console.warn(
    JSON.stringify({
      level: "warn",
      marker: FORWARD_FAILED_MARKER,
      reason,
      error: err instanceof Error ? err.message : String(err),
      type: report.type,
      message: report.message,
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
