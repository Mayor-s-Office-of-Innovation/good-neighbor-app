// One bundle, two Lambdas: analytics-query answers the Insights routes, insights-jobs
// runs queued jobs. Kept apart from the api function, so DuckDB's 2 GB can't slow it.

import { reportingRoutes, runReportJob } from "../handlers/admin-reporting.js";
import { jsonResponse } from "../http.js";
import { withServerErrorsLogged } from "../lib/log-server-error.js";

// The queue sends one message per invocation, so a large file gets the whole
// timeout; a bad message goes back to SQS, then the DLQ.
/**
 * @param {{ Records: { messageId: string, body: string }[] }} event
 * @returns {Promise<{ batchItemFailures: { itemIdentifier: string }[] }>}
 */
export async function runJobs(event) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    let ref;
    try {
      ref = JSON.parse(record.body).insightsJob;
    } catch {
      ref = null;
    }
    if (!ref?.ownerKey || !ref?.jobId) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    try {
      await withServerErrorsLogged("analytics-query insights-job", () =>
        runReportJob(ref),
      );
    } catch {
      // Storage was unreachable; the queue's retry starts the job over.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const handler = async (event) => {
  const records = /** @type {any} */ (event).Records;
  if (Array.isArray(records) && records[0]?.eventSource === "aws:sqs")
    return /** @type {any} */ (runJobs(/** @type {any} */ (event)));
  const routeKey = /** @type {any} */ (event).routeKey;
  const fn = Object.hasOwn(reportingRoutes, routeKey)
    ? reportingRoutes[/** @type {keyof typeof reportingRoutes} */ (routeKey)]
    : undefined;
  if (!fn) {
    return jsonResponse(404, { error: "not_found", routeKey });
  }
  return withServerErrorsLogged(
    `analytics-query ${routeKey}`,
    () => fn(event),
    {
      reqId: /** @type {any} */ (event)?.requestContext?.requestId,
    },
  );
};
