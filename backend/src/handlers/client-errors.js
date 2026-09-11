/*
 * POST /v1/client-errors — public, unauthenticated intake for field-app error
 * reports (see docs/todo/client-error-tracking-plan.md). Contract: always
 * respond 204, never throw, never signal payload validity to a possible
 * abuser. Valid reports are scrubbed, logged as structured JSON, and handed
 * to the PostHog forwarder (which is log-only until the egress sign-off).
 */

import { readJsonBody } from "../http.js";
import { forwardClientError } from "./forwarder.js";
import { scrubClientErrorReport } from "./scrub-client-error.js";

/*
 * The log marker for validation drops (metric-filter abuse signal — silent
 * drops would hide exactly what Phase 4 alarms on).
 */
export const DROPPED_MARKER = "ClientErrorDropped";

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

  const report = scrubClientErrorReport(body);
  if (!report) {
    // Drop garbage quietly but observably: one compact JSON line so the
    // ClientErrorDropped metric filter has something to count.
    console.warn(
      JSON.stringify({
        level: "warn",
        marker: DROPPED_MARKER,
        reason: "invalid_payload",
      }),
    );
    return { statusCode: 204 };
  }

  await forwardClientError(report, { userAgent: readUserAgent(event) });

  // Always 204 No Content — validity is never signalled back.
  return { statusCode: 204 };
};

/**
 * Read the caller's user-agent header (any casing) for the forwarder to attach.
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
