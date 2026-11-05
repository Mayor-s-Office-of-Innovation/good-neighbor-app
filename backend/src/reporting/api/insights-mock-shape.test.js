// The admin E2E suite runs against e2e/admin-tests/insights-mock.js. This
// holds that fake to the real handlers: same routes, same status, same
// fields and value types, so a changed reply can't leave specs passing.
import { describe, expect, it } from "vitest";
import {
  insightsReplies,
  insightsReply,
} from "../../../../e2e/admin-tests/insights-mock.js";
import {
  createReportingHandlers,
  reportingRoutes,
} from "../../handlers/admin-reporting.js";
import { memoryJobStore } from "./jobs.js";
import { createSnapshotStore } from "./snapshot.js";
import { syntheticProjection } from "./test-projection.js";

/**
 * Values differ between fixtures; names and types are what pages rely on.
 * Arrays take the shape of their first element.
 * @param {unknown} value
 * @returns {unknown}
 */
function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value))
    return value.length ? [shapeOf(value[0])] : ["empty"];
  if (typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shapeOf(/** @type {any} */ (value)[k])]),
    );
  return typeof value;
}

/**
 * A null on either side matches any type, since a nullable field is null in
 * one fixture and set in the other. A test below checks that the lists
 * pages draw from have rows on the handler side, so nothing hides there.
 * @param {unknown} real
 * @param {unknown} mock
 * @param {string} [at]
 * @returns {string[]}
 */
function differences(real, mock, at = "") {
  if (real === "null" || mock === "null") return [];
  if (Array.isArray(real) || Array.isArray(mock)) {
    if (!Array.isArray(real) || !Array.isArray(mock))
      return [`${at}: array in one reply only`];
    // An empty list says nothing about its rows, like a null.
    if (real[0] === "empty" || mock[0] === "empty") return [];
    return differences(real[0], mock[0], `${at}[0]`);
  }
  if (real && typeof real === "object" && mock && typeof mock === "object") {
    const keys = new Set([...Object.keys(real), ...Object.keys(mock)]);
    return [...keys].flatMap((k) =>
      !(k in real)
        ? [`${at}.${k}: only in the mock`]
        : !(k in mock)
          ? [`${at}.${k}: missing from the mock`]
          : differences(
              /** @type {any} */ (real)[k],
              /** @type {any} */ (mock)[k],
              `${at}.${k}`,
            ),
    );
  }
  const show = (/** @type {unknown} */ v) =>
    typeof v === "string" ? v : JSON.stringify(v);
  return real === mock
    ? []
    : [`${at}: ${show(real)} in the handler, ${show(mock)} in the mock`];
}

let keys = 0;
/**
 * @param {{ query?: Record<string, string>, path?: Record<string, string>, body?: unknown }} [opts]
 * @returns {any}
 */
const event = ({ query, path, body } = {}) => ({
  requestContext: {
    authorizer: {
      jwt: { claims: { "cognito:groups": "compliance-manager", sub: "m1" } },
    },
  },
  headers: { "idempotency-key": `shape-key-${(keys += 1)}` },
  queryStringParameters: query,
  pathParameters: path,
  body: body === undefined ? undefined : JSON.stringify(body),
});

const october = { period: "month", month: "2026-10" };

/** @type {any} */
let handlers;

/** @returns {Promise<Record<string, any>>} each route's real reply */
async function realReplies() {
  const projection = syntheticProjection();
  /** @type {{ ownerKey: string, jobId: string }[]} */
  const started = [];
  const h = createReportingHandlers({
    snapshots: createSnapshotStore({
      source: {
        latest: async () => ({ prefix: "p1", snapshotId: "snap1" }),
        load: async (prefix) => ({
          prefix,
          manifest: projection.manifest,
          tables: projection.tables,
        }),
      },
    }),
    jobStore: memoryJobStore(),
    starter: async (ref) => {
      started.push(ref);
    },
    now: () => Date.parse("2026-11-04T20:00:00.000Z"),
  });
  handlers = h;
  const done = await h.postExport(
    event({ body: { dataset: "issues", ...october } }),
  );
  await h.runJob(started[0]);
  const queued = await h.postExport(
    event({ body: { dataset: "checks", ...october } }),
  );
  return {
    "GET reporting/overview": await h.getOverview(event({ query: october })),
    "GET reporting/sites/{siteId}": await h.getSite(
      event({ query: october, path: { siteId: "s1" } }),
    ),
    "GET reporting/issues": await h.listIssues(event({ query: october })),
    "GET reporting/issues/{issueId}": await h.getIssue(
      event({ path: { issueId: "t1" } }),
    ),
    "GET reporting/checks": await h.listChecks(event({ query: october })),
    "GET reporting/checks/{checkId}": await h.getCheck(
      event({ path: { checkId: "c1" } }),
    ),
    "GET reporting/scope-options": await h.getScopeOptions(event()),
    "POST reporting/trends": await h.postTrends(
      event({
        body: {
          ...october,
          scope: { siteIds: ["s1"] },
          breakdown: "department",
        },
      }),
    ),
    "POST reporting/exports": await h.postExport(
      event({ body: { dataset: "sites", ...october } }),
    ),
    "POST reports/insights": await h.postReport(
      event({ body: { siteIds: ["s1"], ...october } }),
    ),
    "GET reports/{jobId}": await h.getJob(
      event({ path: { jobId: JSON.parse(done.body).job.jobId } }),
    ),
    "DELETE reports/{jobId}": await h.cancelJob(
      event({ path: { jobId: JSON.parse(queued.body).job.jobId } }),
    ),
  };
}

const replies = await realReplies();

describe("the admin E2E Insights mock", () => {
  it("answers every Insights route the backend serves, and no others", () => {
    const backend = Object.keys(reportingRoutes)
      .map((k) => k.replace(" /admin/v1/", " "))
      .sort();
    expect(Object.keys(insightsReplies).sort()).toEqual(backend);
  });

  it("compares against real replies with rows and a finished job", () => {
    const body = (/** @type {string} */ route) =>
      JSON.parse(replies[route].body);
    expect([
      body("GET reporting/overview").sites.length,
      body("GET reporting/sites/{siteId}").days.length,
      body("GET reporting/issues").issues.length,
      body("GET reporting/checks").checks.length,
      body("POST reporting/trends").series.current.length,
      body("POST reporting/trends").series.prior.length,
      body("POST reporting/trends").categories.length,
      body("POST reporting/trends").breakdown.length,
      body("GET reporting/checks/{checkId}").issues.length,
      body("GET reporting/scope-options").sites.length,
    ]).not.toContain(0);
    expect(body("GET reports/{jobId}").job.state).toBe("succeeded");
  });

  it.each([
    ["reporting/issues/nope", "getIssue", { issueId: "nope" }],
    ["reporting/checks/nope", "getCheck", { checkId: "nope" }],
    ["reporting/sites/nope", "getSite", { siteId: "nope" }],
    ["reports/nope", "getJob", { jobId: "nope" }],
    // POST makes a report there; a read asks for a job of that name.
    ["reports/insights", "getJob", { jobId: "insights" }],
  ])(
    "answers an unknown ID in %s as the handler does",
    async (path, name, ids) => {
      const real = await /** @type {any} */ (handlers)[name](
        event({ path: ids, query: october }),
      );
      const mock = insightsReply({
        method: "GET",
        path,
        search: "period=month&month=2026-10",
      });
      expect([mock?.status, mock?.json]).toEqual([
        real.statusCode,
        JSON.parse(real.body),
      ]);
    },
  );

  it.each(["ascending", ""])(
    "refuses a sort direction of %j as the handler does",
    async (dir) => {
      const real = await handlers.getOverview(
        event({ query: { ...october, dir } }),
      );
      const mock = insightsReply({
        method: "GET",
        path: "reporting/overview",
        search: `period=month&month=2026-10&dir=${dir}`,
      });
      expect([mock?.status, mock?.json]).toEqual([
        real.statusCode,
        JSON.parse(real.body),
      ]);
    },
  );

  it("opens the record of every Issue its lists show", () => {
    const listed = insightsReply({
      method: "GET",
      path: "reporting/issues",
      search: "period=month&month=2026-10",
    })?.json.issues.map((/** @type {any} */ i) => i.issueId);
    const opened = listed.map(
      (/** @type {string} */ id) =>
        insightsReply({ method: "GET", path: `reporting/issues/${id}` })?.json
          .issue?.issueId,
    );
    expect([listed.length > 1, opened]).toEqual([true, listed]);
  });

  it.each(Object.keys(insightsReplies))(
    "matches the handler's status and reply shape for %s",
    (route) => {
      const real = replies[route];
      const mock = insightsReplies[route];
      expect(mock.status ?? 200).toBe(real.statusCode);
      expect(
        differences(shapeOf(JSON.parse(real.body)), shapeOf(mock.json)),
      ).toEqual([]);
    },
  );
});
