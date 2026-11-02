// Forward scrubbed client analytics events to PostHog as plain named events
// (`$pageview`, `camera_opened`, ...). Sibling of forwarder.js ($exception)
// and feedback-forwarder.js (`survey sent`): same key resolution, same
// log-only default, same best-effort contract — failures become WARN lines
// and the intake still answers 204. A request's events go to PostHog in one
// `/batch/` call; the structured log still carries one line per event so
// CloudWatch keeps the per-event device picture.
//
// Browser/OS/device properties: server-side events carry none unless set, so
// the user-agent header is parsed here (lib/user-agent.js) into PostHog's
// `$browser` / `$os` / `$device_type` family. The structured log line carries
// the same properties, so the device picture is available in CloudWatch even
// while the forwarder is log-only.

import { getPosthogConfig } from "../config.js";
import { parseUserAgent } from "../lib/user-agent.js";
import { getPosthogApiKey } from "./posthog-api-key.js";
import { toIso, withTimeout } from "./forwarder.js";

const DEFAULT_HOST = "https://us.i.posthog.com";

export const FORWARD_FAILED_MARKER = "ClientEventForwardFailed";
export const FORWARD_OK_MARKER = "ClientEventForwarded";
export const LOG_ONLY_MARKER = "ClientEventLogOnly";
/**
 * Egress budget per batch. The intake answers only after the forward settles,
 * so a slow PostHog must cost a dropped batch rather than a held Lambda
 * execution. 1 s is generous for a healthy ingest (typically ~100-300 ms,
 * dominated by the round trip rather than batch size) and a third of the
 * error forwarder's.
 */
export const EVENT_FORWARD_TIMEOUT_MS = 1000;

/**
 * Browser/OS/device properties derived from the request's user-agent.
 * @param {string | undefined} userAgent
 * @returns {Record<string, string | boolean>}
 */
export function userAgentProperties(userAgent) {
  if (!userAgent) return {};
  const ua = parseUserAgent(userAgent);
  return {
    $browser: ua.browser,
    ...(ua.browserVersion ? { $browser_version: ua.browserVersion } : {}),
    $os: ua.os,
    ...(ua.osVersion ? { $os_version: ua.osVersion } : {}),
    $device_type: ua.deviceType,
    ...(ua.webview ? { android_webview: true } : {}),
    $raw_user_agent: userAgent.slice(0, 500),
  };
}

/**
 * Build the PostHog batch event for a scrubbed client event.
 * @param {import("./scrub-client-event.js").ScrubbedClientEvent} report
 * @param {{ userAgent?: string }} ctx
 * @returns {Record<string, unknown>}
 */
export function toPosthogEvent(report, ctx) {
  const ts = toIso(report.ts);
  return {
    event: report.event,
    distinct_id: report.id,
    properties: {
      ...report.properties,
      ...userAgentProperties(ctx.userAgent),
      ...(report.release ? { release: report.release } : {}),
      $lib: "gnp-client-events",
      // Anonymous events: no person profile is created or updated. The
      // distinct id still groups events per browser.
      $process_person_profile: false,
    },
    ...(ts ? { timestamp: ts } : {}),
  };
}

/**
 * @typedef {object} ForwardDeps
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [host]
 * @property {() => number} [now]
 * @property {import("../config.js").PosthogConfig} [config]
 * @property {number} [timeoutMs] egress budget; defaults to
 *   EVENT_FORWARD_TIMEOUT_MS (the request-path figure — the queue consumer
 *   passes a longer one because nothing waits on it)
 */

/**
 * Events that share one request context (user agent). A PostHog call may
 * carry several groups — the queue consumer forwards a whole SQS batch, one
 * group per message, in a single call.
 * @typedef {{ reports: import("./scrub-client-event.js").ScrubbedClientEvent[],
 *   ctx: { userAgent?: string } }} ClientEventGroup
 */

/**
 * Forward one scrubbed client event. Never throws. Thin wrapper over
 * forwardClientEventGroups for callers (and tests) holding a single event.
 * @param {import("./scrub-client-event.js").ScrubbedClientEvent} report
 * @param {{ userAgent?: string }} ctx
 * @param {ForwardDeps} [deps]
 * @returns {Promise<"forwarded" | "log-only" | "failed">}
 */
export function forwardClientEvent(report, ctx, deps = {}) {
  return forwardClientEventGroups([{ reports: [report], ctx }], deps);
}

/**
 * Forward a request's scrubbed client events in one PostHog `/batch/` call.
 * Never throws.
 * @param {import("./scrub-client-event.js").ScrubbedClientEvent[]} reports
 * @param {{ userAgent?: string }} ctx
 * @param {ForwardDeps} [deps]
 * @returns {Promise<"forwarded" | "log-only" | "failed">}
 */
export function forwardClientEvents(reports, ctx, deps = {}) {
  return forwardClientEventGroups([{ reports, ctx }], deps);
}

/**
 * Forward several groups of scrubbed client events, each with its own user
 * agent, in one PostHog `/batch/` call. Never throws. The outcome is per
 * call: every event is forwarded, logged-only, or failed together, so a
 * queue consumer can retry or acknowledge the whole SQS batch on it.
 * @param {ClientEventGroup[]} groups
 * @param {ForwardDeps} [deps]
 * @returns {Promise<"forwarded" | "log-only" | "failed">}
 */
export async function forwardClientEventGroups(groups, deps = {}) {
  const entries = groups.flatMap((group) =>
    group.reports.map((report) => ({
      report,
      posthogEvent: toPosthogEvent(report, group.ctx),
    })),
  );
  if (entries.length === 0) return "log-only";
  const posthogEvents = entries.map((entry) => entry.posthogEvent);
  const logFields = entries.map((entry) => ({
    event: entry.report.event,
    properties: entry.posthogEvent.properties,
    batch_size: entries.length,
  }));

  let apiKey;
  try {
    apiKey = await getPosthogApiKey(deps.config ?? getPosthogConfig());
  } catch (err) {
    for (const fields of logFields) {
      warnForwardFailed("secret_fetch_failed", err, fields);
    }
    return "failed";
  }

  if (!apiKey) {
    for (const fields of logFields) {
      console.log(
        JSON.stringify({ level: "info", marker: LOG_ONLY_MARKER, ...fields }),
      );
    }
    return "log-only";
  }

  const host = deps.host || process.env.POSTHOG_HOST || DEFAULT_HOST;
  const body = {
    api_key: apiKey,
    batch: posthogEvents,
    sent_at: new Date((deps.now ?? Date.now)()).toISOString(),
  };

  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await withTimeout(
      fetchImpl(`${host}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      deps.timeoutMs ?? EVENT_FORWARD_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`PostHog ingest returned ${res.status}`);
    }
    for (const fields of logFields) {
      console.log(
        JSON.stringify({ level: "info", marker: FORWARD_OK_MARKER, ...fields }),
      );
    }
    return "forwarded";
  } catch (err) {
    for (const fields of logFields) {
      warnForwardFailed("forward_failed", err, fields);
    }
    return "failed";
  }
}

/**
 * The WARN line carries the same event + device properties as the OK and
 * log-only lines: during a PostHog outage it is the only record of the
 * event, and the browser/OS/model detail is what an investigation needs.
 * @param {string} reason
 * @param {unknown} err
 * @param {{ event: string, properties: unknown }} logFields
 */
function warnForwardFailed(reason, err, logFields) {
  console.warn(
    JSON.stringify({
      level: "warn",
      marker: FORWARD_FAILED_MARKER,
      reason,
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
