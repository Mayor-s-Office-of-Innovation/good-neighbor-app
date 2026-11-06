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
  // Insights replaced the Analytics page, so its catalog and SQL routes are gone.
  it.each([
    "GET /admin/v1/analytics/queries",
    "POST /admin/v1/analytics/queries/{queryId}",
    "POST /admin/v1/analytics/query",
  ])("404s on the old Analytics route %s", async (routeKey) => {
    const res = /** @type {any} */ (
      await handler(event(routeKey), /** @type {any} */ ({}), () => {})
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(String(res.body)).error).toBe("not_found");
  });

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
