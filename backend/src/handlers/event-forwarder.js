// Forward a scrubbed client analytics event to PostHog as a plain named event
// (`$pageview`, `camera_opened`, ...). Sibling of forwarder.js ($exception)
// and feedback-forwarder.js (`survey sent`): same key resolution, same
// log-only default, same best-effort contract — failures become WARN lines
// and the intake still answers 204.
//
// Browser/OS/device properties: server-side events carry none unless set, so
// the user-agent header is parsed here (lib/user-agent.js) into PostHog's
// `$browser` / `$os` / `$device_type` family. The structured log line carries
// the same properties, so the device picture is available in CloudWatch even
// while the forwarder is log-only.

import { getConfig } from "../config.js";
import { parseUserAgent } from "../lib/user-agent.js";
import { getPosthogApiKey } from "./posthog-api-key.js";
import { toIso, withTimeout } from "./forwarder.js";

const DEFAULT_HOST = "https://us.i.posthog.com";

export const FORWARD_FAILED_MARKER = "ClientEventForwardFailed";
export const FORWARD_OK_MARKER = "ClientEventForwarded";
export const LOG_ONLY_MARKER = "ClientEventLogOnly";
/**
 * Egress budget per event. Page views fire on every route change, and the
 * intake answers only after the forward settles, so a slow PostHog must cost
 * a dropped event rather than a held Lambda execution. 1 s is generous for a
 * healthy ingest (typically ~100-300 ms) and a third of the error forwarder's.
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
 * Forward one scrubbed client event. Never throws.
 * @param {import("./scrub-client-event.js").ScrubbedClientEvent} report
 * @param {{ userAgent?: string }} ctx
 * @param {{ fetchImpl?: typeof fetch, host?: string, now?: () => number,
 *   config?: import("../config.js").AppConfig }} [deps]
 * @returns {Promise<"forwarded" | "log-only" | "failed">}
 */
export async function forwardClientEvent(report, ctx, deps = {}) {
  const posthogEvent = toPosthogEvent(report, ctx);
  const logFields = {
    event: report.event,
    properties: posthogEvent.properties,
  };

  let apiKey;
  try {
    apiKey = await getPosthogApiKey(deps.config ?? getConfig());
  } catch (err) {
    warnForwardFailed("secret_fetch_failed", err, logFields);
    return "failed";
  }

  if (!apiKey) {
    console.log(
      JSON.stringify({ level: "info", marker: LOG_ONLY_MARKER, ...logFields }),
    );
    return "log-only";
  }

  const host = deps.host || process.env.POSTHOG_HOST || DEFAULT_HOST;
  const body = {
    api_key: apiKey,
    batch: [posthogEvent],
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
      EVENT_FORWARD_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`PostHog ingest returned ${res.status}`);
    }
    console.log(
      JSON.stringify({
        level: "info",
        marker: FORWARD_OK_MARKER,
        ...logFields,
      }),
    );
    return "forwarded";
  } catch (err) {
    warnForwardFailed("forward_failed", err, logFields);
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
