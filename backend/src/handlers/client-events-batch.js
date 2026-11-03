/*
 * Shared unpack + scrub for client analytics event payloads. Two transports
 * feed the same PostHog forwarder:
 *
 *   - production: API Gateway writes the request body straight to the
 *     client-events SQS queue and the consumer (lambda/client-events-consumer.js)
 *     reads batches of bodies;
 *   - local dev harness and the intake Lambda fallback: the HTTP handler
 *     (handlers/client-events.js) reads one body per request.
 *
 * Both call unpackEnvelope → scrubClientEventBatch → logDroppedClientEvents
 * here so the accepted shapes, the per-request cap, and the drop line stay
 * one definition.
 */

import { scrubClientEvent } from "./scrub-client-event.js";

/** Log marker for validation drops (metric-filter abuse signal). */
export const DROPPED_MARKER = "ClientEventDropped";
/**
 * Most events accepted from one body. Matches the client's count cap
 * (frontend/src/services/analytics.js MAX_BATCH); a larger server cap would
 * only widen what an anonymous caller can push through one rate-limited
 * request. The WAF's 8 KiB body limit caps a body at about ten realistic
 * events before this does.
 */
export const MAX_BATCH = 25;
/** Longest user agent read from the envelope; the forwarder logs ≤500 too. */
export const MAX_USER_AGENT = 500;

/**
 * The body's events and, when the client supplied one, its user agent.
 * `{ batch: [...], ua }` → the items; any other object → a one-item list;
 * garbage (including an empty or non-array `batch`) → no items.
 *
 * The user agent lives in the body because the deployed transport hands the
 * body to SQS untouched: API Gateway could only add the header by splicing
 * it into a JSON mapping it cannot escape. It is as client-controlled as the
 * header was.
 * @param {unknown} body
 * @returns {{ items: unknown[], userAgent: string | undefined }}
 */
export function unpackEnvelope(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { items: [], userAgent: undefined };
  }
  const raw = /** @type {Record<string, unknown>} */ (body);
  const userAgent = envelopeUserAgent(raw);
  if ("batch" in raw) {
    return {
      items: Array.isArray(raw.batch) ? raw.batch : [],
      userAgent,
    };
  }
  return { items: [raw], userAgent };
}

/**
 * The client-supplied user agent from a body's `ua` field, capped. Shared by
 * the events envelope and the client-errors body: both travel through SQS,
 * where no request header survives.
 * @param {unknown} body
 * @returns {string | undefined}
 */
export function envelopeUserAgent(body) {
  if (typeof body !== "object" || body === null) return undefined;
  const ua = /** @type {Record<string, unknown>} */ (body).ua;
  return typeof ua === "string" && ua ? ua.slice(0, MAX_USER_AGENT) : undefined;
}

/**
 * Scrub the first MAX_BATCH items; count what was rejected and what was
 * never looked at.
 * @param {unknown[]} items
 * @returns {{
 *   reports: import("./scrub-client-event.js").ScrubbedClientEvent[],
 *   received: number, invalid: number, truncated: number }}
 */
export function scrubClientEventBatch(items) {
  const considered = items.slice(0, MAX_BATCH);
  /** @type {import("./scrub-client-event.js").ScrubbedClientEvent[]} */
  const reports = [];
  for (const item of considered) {
    const report = scrubClientEvent(item);
    if (report) reports.push(report);
  }
  return {
    reports,
    received: items.length,
    invalid: considered.length - reports.length,
    truncated: items.length - considered.length,
  };
}

/**
 * One WARN line per body that carried garbage (or nothing), never per item:
 * the ClientEventDropped alarm counts bodies, which is the unit an abuser
 * pays for. Silent when everything was accepted.
 * @param {{ received: number, invalid: number, truncated: number }} counts
 * @param {"http" | "queue"} source
 */
export function logDroppedClientEvents(counts, source) {
  const { received, invalid, truncated } = counts;
  if (received > 0 && invalid === 0 && truncated === 0) return;
  console.warn(
    JSON.stringify({
      level: "warn",
      marker: DROPPED_MARKER,
      reason: received === 0 ? "invalid_payload" : "invalid_items",
      source,
      received,
      dropped: invalid + truncated,
      invalid,
      truncated,
    }),
  );
}
