/*
 * POST /v1/client-events — public, unauthenticated intake for field-app
 * analytics events (page views, setup, camera hand-offs). Same contract as
 * client-errors.js: always 204, never throw, never signal validity. Valid
 * events are scrubbed, logged as structured JSON with their device
 * properties, and handed to the PostHog event forwarder.
 */

import { readJsonBody } from "../http.js";
import { forwardClientEvent } from "./event-forwarder.js";
import { scrubClientEvent } from "./scrub-client-event.js";

/** Log marker for validation drops (metric-filter abuse signal). */
export const DROPPED_MARKER = "ClientEventDropped";

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

  const report = scrubClientEvent(body);
  if (!report) {
    console.warn(
      JSON.stringify({
        level: "warn",
        marker: DROPPED_MARKER,
        reason: "invalid_payload",
      }),
    );
    return { statusCode: 204 };
  }

  await forwardClientEvent(report, { userAgent: readUserAgent(event) });
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
