/*
 * POST /v1/client-events — public, unauthenticated intake for field-app
 * analytics events (page views, setup, camera hand-offs). Same contract as
 * client-errors.js: always 204, never throw, never signal validity. Valid
 * events are scrubbed, logged as structured JSON with their device
 * properties, and handed to the PostHog event forwarder.
 *
 * The body is either one event or `{ batch: [event, ...] }` — the client
 * (frontend/src/services/analytics.js) queues events and flushes a batch, so
 * a perimeter check costs a few invocations and one PostHog call per batch
 * rather than one of each per event. Items past MAX_BATCH are dropped (the
 * client flushes at 25), as is any item that fails the scrub; the valid rest
 * still forward.
 */

import { readJsonBody } from "../http.js";
import { forwardClientEvents } from "./event-forwarder.js";
import { scrubClientEvent } from "./scrub-client-event.js";

/** Log marker for validation drops (metric-filter abuse signal). */
export const DROPPED_MARKER = "ClientEventDropped";
/** Most events accepted from one request; the client flushes at 25. */
export const MAX_BATCH = 50;

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

  const items = unpackBatch(body);
  const considered = items.slice(0, MAX_BATCH);
  /** @type {import("./scrub-client-event.js").ScrubbedClientEvent[]} */
  const reports = [];
  for (const item of considered) {
    const report = scrubClientEvent(item);
    if (report) reports.push(report);
  }
  const invalid = considered.length - reports.length;
  const truncated = items.length - considered.length;
  if (items.length === 0 || invalid > 0 || truncated > 0) {
    // One line per request, not per item: the ClientEventDropped alarm counts
    // requests carrying garbage, which is the unit an abuser pays for.
    console.warn(
      JSON.stringify({
        level: "warn",
        marker: DROPPED_MARKER,
        reason: items.length === 0 ? "invalid_payload" : "invalid_items",
        received: items.length,
        dropped: invalid + truncated,
        invalid,
        truncated,
      }),
    );
  }
  if (reports.length === 0) {
    return { statusCode: 204 };
  }

  await forwardClientEvents(reports, { userAgent: readUserAgent(event) });
  return { statusCode: 204 };
};

/**
 * `{ batch: [...] }` → its items; any other object → a one-item list; garbage
 * (including an empty or non-array `batch`) → an empty list.
 * @param {unknown} body
 * @returns {unknown[]}
 */
function unpackBatch(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [];
  }
  if ("batch" in body) {
    const batch = /** @type {{ batch: unknown }} */ (body).batch;
    return Array.isArray(batch) ? batch : [];
  }
  return [body];
}

/**
 * @param {unknown} event
 * @returns {string | undefined}
 */
function readUserAgent(event) {
  try {
    const headers =
      /** @type {{ headers?: Record<string, string | undefined> } | undefined} */ (
        event
      )?.headers;
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
