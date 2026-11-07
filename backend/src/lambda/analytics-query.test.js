import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reporting } = vi.hoisted(() => {
  /** @param {string} body */
  const reply = (body) => vi.fn(async () => ({ statusCode: 200, body }));
  return {
    reporting: {
      getReportingOverview: reply("overview"),
      getReportingSite: reply("site"),
      listReportingIssues: reply("issues"),
      getReportingIssue: reply("issue"),
      listReportingChecks: reply("checks"),
      getReportingCheck: reply("check"),
      getReportingScopeOptions: reply("scope"),
      postReportingTrends: reply("trends"),
      postReportingExport: reply("export"),
      postInsightsReport: reply("report"),
      getReportJob: reply("job"),
      cancelReportJob: reply("cancel"),
      runReportJob: vi.fn(async () => {}),
    },
  };
});
vi.mock("../handlers/admin-reporting.js", () => ({
  runReportJob: reporting.runReportJob,
  reportingRoutes: {
    "GET /admin/v1/reporting/overview": reporting.getReportingOverview,
    "GET /admin/v1/reporting/sites/{siteId}": reporting.getReportingSite,
    "GET /admin/v1/reporting/issues": reporting.listReportingIssues,
    "GET /admin/v1/reporting/issues/{issueId}": reporting.getReportingIssue,
    "GET /admin/v1/reporting/checks": reporting.listReportingChecks,
    "GET /admin/v1/reporting/checks/{checkId}": reporting.getReportingCheck,
    "GET /admin/v1/reporting/scope-options": reporting.getReportingScopeOptions,
    "POST /admin/v1/reporting/trends": reporting.postReportingTrends,
    "POST /admin/v1/reporting/exports": reporting.postReportingExport,
    "POST /admin/v1/reports/insights": reporting.postInsightsReport,
    "GET /admin/v1/reports/{jobId}": reporting.getReportJob,
    "DELETE /admin/v1/reports/{jobId}": reporting.cancelReportJob,
  },
}));

// Remove each entry when the gateway catches up, so a new mismatch fails CI.
const NOT_ROUTED_YET =
  "Insights route; its gateway route comes with a later infrastructure change";
const ANALYTICS_REMOVED =
  "Analytics page removed; its gateway route goes with a later infrastructure change";
/** @type {Record<string, string>} */
const KNOWN_ROUTE_GAPS = {
  "GET /admin/v1/reporting/overview": NOT_ROUTED_YET,
  "GET /admin/v1/reporting/sites/{siteId}": NOT_ROUTED_YET,
  "GET /admin/v1/reporting/issues": NOT_ROUTED_YET,
  "GET /admin/v1/reporting/issues/{issueId}": NOT_ROUTED_YET,
  "GET /admin/v1/reporting/checks": NOT_ROUTED_YET,
  "GET /admin/v1/reporting/checks/{checkId}": NOT_ROUTED_YET,
  "GET /admin/v1/reporting/scope-options": NOT_ROUTED_YET,
  "POST /admin/v1/reporting/trends": NOT_ROUTED_YET,
  "POST /admin/v1/reporting/exports": NOT_ROUTED_YET,
  "POST /admin/v1/reports/insights": NOT_ROUTED_YET,
  "GET /admin/v1/reports/{jobId}": NOT_ROUTED_YET,
  "DELETE /admin/v1/reports/{jobId}": NOT_ROUTED_YET,
  "GET /admin/v1/analytics/queries": ANALYTICS_REMOVED,
  "POST /admin/v1/analytics/queries/{queryId}": ANALYTICS_REMOVED,
  "POST /admin/v1/analytics/query": ANALYTICS_REMOVED,
};

const { handler } = await import("./analytics-query.js");
const mocked = await import("../handlers/admin-reporting.js");

// A block body: a returned value would run as the hook's teardown.
beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * @param {string} routeKey
 * @returns {any}
 */
const event = (routeKey) => ({
  routeKey,
  requestContext: { requestId: "req-1" },
});

describe("analytics-query lambda", () => {
  it.each([
    ["GET /admin/v1/reporting/overview", "getReportingOverview"],
    ["GET /admin/v1/reporting/sites/{siteId}", "getReportingSite"],
    ["GET /admin/v1/reporting/issues", "listReportingIssues"],
    ["GET /admin/v1/reporting/issues/{issueId}", "getReportingIssue"],
    ["GET /admin/v1/reporting/checks", "listReportingChecks"],
    ["GET /admin/v1/reporting/checks/{checkId}", "getReportingCheck"],
    ["GET /admin/v1/reporting/scope-options", "getReportingScopeOptions"],
    ["POST /admin/v1/reporting/trends", "postReportingTrends"],
    ["POST /admin/v1/reporting/exports", "postReportingExport"],
    ["POST /admin/v1/reports/insights", "postInsightsReport"],
    ["GET /admin/v1/reports/{jobId}", "getReportJob"],
    ["DELETE /admin/v1/reports/{jobId}", "cancelReportJob"],
  ])("dispatches Insights route %s", async (routeKey, name) => {
    await handler(event(routeKey), /** @type {any} */ ({}), () => {});
    expect(
      reporting[/** @type {keyof typeof reporting} */ (name)],
    ).toHaveBeenCalledWith(event(routeKey));
  });

  it("mocks exactly the routes the real reporting module serves", async () => {
    /** @type {any} */
    const real = await vi.importActual("../handlers/admin-reporting.js");
    expect(Object.keys(mocked.reportingRoutes).sort()).toEqual(
      Object.keys(real.reportingRoutes).sort(),
    );
  });

  it("serves exactly the routes API Gateway sends it, apart from the known gaps", () => {
    const terraform = readFileSync(
      new URL("../../../infra/modules/app/api.tf", import.meta.url),
      "utf8",
    );
    const block = /analytics_routes\s*=\s*\[([^\]]*)\]/.exec(terraform);
    const deployed = [...String(block?.[1]).matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(deployed.length).toBeGreaterThan(0);
    const served = Object.keys(mocked.reportingRoutes);
    const gaps = Object.keys(KNOWN_ROUTE_GAPS);
    expect(served.filter((key) => !deployed.includes(key)).sort()).toEqual(
      gaps.filter((key) => served.includes(key)).sort(),
    );
    expect(deployed.filter((key) => !served.includes(key)).sort()).toEqual(
      gaps.filter((key) => deployed.includes(key)).sort(),
    );
  });

  it("runs the good jobs in a batch and returns only the bad ones", async () => {
    const res = await handler(
      /** @type {any} */ ({
        Records: [
          { eventSource: "aws:sqs", messageId: "bad", body: "{" },
          {
            eventSource: "aws:sqs",
            messageId: "good",
            body: JSON.stringify({
              insightsJob: { ownerKey: "o", jobId: "j" },
            }),
          },
        ],
      }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
    expect(reporting.runReportJob).toHaveBeenCalledOnce();
    expect(reporting.runReportJob).toHaveBeenCalledWith({
      ownerKey: "o",
      jobId: "j",
    });
  });

  it("runs each queued Insights job from its SQS message", async () => {
    const ref = { ownerKey: "o", jobId: "j1" };
    const res = await handler(
      /** @type {any} */ ({
        Records: [
          {
            eventSource: "aws:sqs",
            messageId: "m1",
            body: JSON.stringify({ insightsJob: ref }),
          },
        ],
      }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(reporting.runReportJob).toHaveBeenCalledWith(ref);
    expect(res).toEqual({ batchItemFailures: [] });
  });

  it("returns a job that hit a storage error as failed, so SQS retries it", async () => {
    reporting.runReportJob.mockRejectedValueOnce(new Error("s3 down"));
    const res = await handler(
      /** @type {any} */ ({
        Records: [
          {
            eventSource: "aws:sqs",
            messageId: "m3",
            body: JSON.stringify({
              insightsJob: { ownerKey: "o", jobId: "j" },
            }),
          },
        ],
      }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m3" }] });
  });

  it("returns a message it can't read as failed, so SQS retries or parks it", async () => {
    const res = await handler(
      /** @type {any} */ ({
        Records: [{ eventSource: "aws:sqs", messageId: "m2", body: "{" }],
      }),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m2" }] });
    expect(reporting.runReportJob).not.toHaveBeenCalled();
  });

  it("404s on any other route key", async () => {
    const res = /** @type {any} */ (
      await handler(
        event("GET /admin/v1/providers"),
        /** @type {any} */ ({}),
        () => {},
      )
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(String(res.body)).error).toBe("not_found");
  });
});
