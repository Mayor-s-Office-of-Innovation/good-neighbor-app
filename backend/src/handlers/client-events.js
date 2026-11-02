/*
 * POST /v1/client-events — public, unauthenticated intake for field-app
 * analytics events (page views, setup, camera hand-offs). Same contract as
 * client-errors.js: always 204, never throw, never signal validity. Valid
 * events are scrubbed, logged as structured JSON with their device
 * properties, and handed to the PostHog event forwarder.
 *
 * The body is either one event or `{ batch: [event, ...], ua }` — the client
 * (frontend/src/services/analytics.js) queues events and flushes a batch
 * with its user agent in the envelope. Items past MAX_BATCH are dropped (the
 * client flushes well below that), as is any item that fails the scrub; the
 * valid rest still forward.
 *
 * Transport note: in deployed environments API Gateway writes this route's
 * bodies straight to the client-events SQS queue and
 * lambda/client-events-consumer.js forwards them (infra/modules/app/
 * client-events.tf), so no Lambda is held while PostHog answers. This HTTP
 * handler serves the local dev harness (scripts/local-api.mjs) and stays
 * wired in lambda/intake.js as a fallback; both paths share
 * client-events-batch.js.
 */

import { readJsonBody } from "../http.js";
import {
  DROPPED_MARKER,
  MAX_BATCH,
  logDroppedClientEvents,
  scrubClientEventBatch,
  unpackEnvelope,
} from "./client-events-batch.js";
import { forwardClientEvents } from "./event-forwarder.js";

export { DROPPED_MARKER, MAX_BATCH };

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

  const { items, userAgent } = unpackEnvelope(body);
  const { reports, ...counts } = scrubClientEventBatch(items);
  logDroppedClientEvents(counts, "http");
  if (reports.length === 0) {
    return { statusCode: 204 };
  }

  // Current clients put the user agent in the envelope (see
  // client-events-batch.js); the header covers older cached clients.
  await forwardClientEvents(reports, {
    userAgent: userAgent ?? readUserAgent(event),
  });
  return { statusCode: 204 };
};

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
