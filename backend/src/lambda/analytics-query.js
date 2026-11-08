// API Gateway (HTTP API v2) entrypoint for the admin analytics routes (ADR
// 0013 ad-hoc leg). A dedicated Lambda, separate from the app api function:
// it carries the DuckDB native binding, needs ~2 GB and a long timeout, and
// its load must never compete with the operational API's concurrency. API
// Gateway targets it through its own integration (infra/modules/app/api.tf,
// `analytics_routes`); the admin JWT authorizer gates every route and the
// handlers re-check central-admin membership.
//
// This table mirrors the analytics routes in `scripts/local-api.mjs` and the
// Terraform `analytics_routes` list; keep all three in step.
//
// It also serves Insights routes and jobs, so reporting load stays off the app
// api; their gateway routes, queue and bucket come in the infra PR.

import {
  listAnalyticsQueries,
  runAnalyticsCatalogQuery,
  runAnalyticsQuery,
} from "../handlers/admin-analytics.js";
import { reportingRoutes, runReportJob } from "../handlers/admin-reporting.js";
import { jsonResponse } from "../http.js";
import { withServerErrorsLogged } from "../lib/log-server-error.js";

// Route key → handler, typed to the call shape (event only), as in api.js.
const routes = /** @type {Record<string, (...args: any[]) => any>} */ ({
  "GET /admin/v1/analytics/queries": listAnalyticsQueries,
  "POST /admin/v1/analytics/queries/{queryId}": runAnalyticsCatalogQuery,
  "POST /admin/v1/analytics/query": runAnalyticsQuery,
  ...reportingRoutes,
});

// Batch size 1 gives a large file the whole timeout; a bad message goes back
// to SQS, then the DLQ.
/**
 * @param {{ Records: { messageId: string, body: string }[] }} event
 * @returns {Promise<{ batchItemFailures: { itemIdentifier: string }[] }>}
 */
async function runJobs(event) {
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
  const fn = routes[routeKey];
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
