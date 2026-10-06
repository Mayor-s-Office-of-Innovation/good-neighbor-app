/*
 * Lambda entrypoint for the best-effort public intakes: client error reports,
 * client analytics events, and user feedback. Split out of api.js (2026-10)
 * so these anonymous routes run under their own small reserved concurrency —
 * each handler awaits a PostHog forward before answering 204, so a PostHog
 * slowdown could otherwise hold the api function's executions and starve
 * uploads and check completion. Here a slow PostHog costs dropped beacons,
 * nothing else.
 *
 * Routes mirror infra/modules/app/api.tf `intake_routes`; the local dev
 * harness (scripts/local-api.mjs) serves the same handlers on one port.
 */

import { handler as clientErrorsHandler } from "../handlers/client-errors.js";
import { handler as clientEventsHandler } from "../handlers/client-events.js";
import { handler as feedbackHandler } from "../handlers/feedback.js";
import { jsonResponse } from "../http.js";
import { withServerErrorsLogged } from "../lib/log-server-error.js";

/**
 * The handlers are typed as full Lambda handlers (event, context, callback),
 * but the dispatcher only ever passes the event — the map is typed to that
 * call shape, as in api.js.
 * @typedef {(event: import("aws-lambda").APIGatewayProxyEventV2) =>
 *   Promise<import("aws-lambda").APIGatewayProxyResultV2>} IntakeHandler
 */

/** @type {Readonly<Record<string, IntakeHandler>>} */
export const routes = Object.freeze(
  /** @type {Record<string, IntakeHandler>} */ (
    /** @type {unknown} */ ({
      "POST /v1/client-errors": clientErrorsHandler,
      "POST /v1/client-events": clientEventsHandler,
      "POST /v1/feedback": feedbackHandler,
    })
  ),
);

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const handler = async (event) => {
  const routeKey = /** @type {{ routeKey?: string }} */ (event).routeKey ?? "";
  const fn = routes[routeKey];
  if (!fn) {
    return jsonResponse(404, { error: "not_found", routeKey });
  }
  return withServerErrorsLogged(`intake ${routeKey}`, () => fn(event), {
    reqId: /** @type {{ requestContext?: { requestId?: string } }} */ (event)
      ?.requestContext?.requestId,
  });
};
