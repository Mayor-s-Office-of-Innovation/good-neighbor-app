// The fake Insights reporting API for admin specs. Replies copy the shape of
// backend/src/handlers/admin-reporting.js; a backend unit test compares the
// two (reporting/api/insights-mock-shape.test.js), so a changed reply fails
// there before a spec passes against an outdated fake.

const TZ = "America/Los_Angeles";
const SITE_ID = "s1";

/**
 * @param {string} startDay
 * @param {string} endDay
 * @param {string} from
 * @param {string} to
 */
const interval = (startDay, endDay, from, to) => ({
  kind: "month",
  startDay,
  endDay,
  from,
  to,
  observedTo: to,
  timezone: TZ,
  incomplete: false,
});

const OCTOBER = interval(
  "2026-10-01",
  "2026-11-01",
  "2026-10-01T07:00:00.000Z",
  "2026-11-01T07:00:00.000Z",
);
const SEPTEMBER = interval(
  "2026-09-01",
  "2026-10-01",
  "2026-09-01T07:00:00.000Z",
  "2026-10-01T07:00:00.000Z",
);

/** @param {ReturnType<typeof interval> | null} period */
const meta = (period) => ({
  apiVersion: "reporting-v1",
  contractVersion: "insights-v1",
  ruleVersion: "2026-11-04",
  snapshotId: "mock-snapshot",
  asOf: "2026-11-04T18:00:00.000Z",
  evaluatedAt: "2026-11-04T19:00:00.000Z",
  timezone: TZ,
  interval: period,
  dataQuality: {
    state: "ok",
    reasons: [],
    coverageStart: "2026-01-01",
    excluded: {
      superseded: 0,
      deleted: 0,
      followUp: 0,
      duplicate: 0,
      afterSnapshot: 0,
      undated: 0,
      undatedChecks: 0,
    },
  },
});

const activity = {
  completedPerimeterChecks: 62,
  singleIssueReports: 3,
  unfinishedChecks: 1,
  issuesCreated: 9,
  severeIssues: 2,
};
const response = {
  awaiting: 1,
  overdue: 1,
  onTime: 6,
  late: 1,
  unknown: 0,
  notTimed: 0,
};
const metrics = { ...activity, ...response };

const comparison = {
  basis: "complete_period",
  days: 31,
  priorDays: 30,
  current: OCTOBER,
  prior: SEPTEMBER,
  priorCoverage: "full",
  change: Object.fromEntries(
    Object.entries(metrics).map(([k, v]) => [
      k,
      { current: v, prior: v - 1, change: 1 },
    ]),
  ),
};

/** @param {string} state */
const contact = (state) => ({
  state,
  reasonCodes: state === "available" ? [] : ["no_site_contact"],
  basis: "current",
  observedAt: "2026-09-01T00:00:00.000Z",
});

const dims = {
  siteId: SITE_ID,
  name: "Example Site",
  status: "active",
  siteType: "shelter",
  providerId: "v1",
  programId: "p1",
  department: "Example Department",
  managerId: "pm1",
  hasLocation: true,
};

const issue = {
  issueId: "t1",
  siteId: SITE_ID,
  checkId: "c1",
  source: "perimeter",
  createdAt: "2026-10-02T17:00:00.000Z",
  createdDay: "2026-10-02",
  category: "Unsecured gate",
  severity: 4,
  severityBand: "severe",
  kind: "onsite",
  type: "onsite",
  status: "open",
  deadlineAt: "2026-10-05T17:00:00.000Z",
  firstResponseAt: "2026-10-03T17:00:00.000Z",
  responseBasis: "timeline",
  responseState: "onTime",
  resolvedAt: null,
  reopened: false,
  sightings: 1,
  followUpTasks: 0,
  latestActivityAt: "2026-10-03T17:00:00.000Z",
};

const check = {
  checkId: "c1",
  siteId: SITE_ID,
  source: "perimeter",
  state: "completed",
  startedAt: "2026-10-02T16:50:00.000Z",
  completedAt: "2026-10-02T17:00:00.000Z",
  activityAt: "2026-10-02T17:00:00.000Z",
  day: "2026-10-02",
  issues: 1,
};

const siteRef = {
  siteId: SITE_ID,
  name: "Example Site",
  manageHref: "/sites/s1",
};

/** @param {string} state */
const job = (state) => ({
  jobId: "mock-job",
  kind: "export",
  state,
  request: { dataset: "issues", period: "month", month: "2026-10" },
  snapshotId: "mock-snapshot",
  createdAt: "2026-11-04T20:00:00.000Z",
  updatedAt: "2026-11-04T20:00:00.000Z",
  expiresAt: "2026-11-05T20:00:00.000Z",
  error: null,
  result:
    state === "succeeded"
      ? {
          filename: "insights-issues.csv",
          contentType: "text/csv; charset=utf-8",
          rows: 9,
          bytes: 2048,
        }
      : null,
  dataQuality: null,
  downloadUrl:
    state === "succeeded" ? "/mock-downloads/insights-issues.csv" : null,
});

/** @param {Record<string, number>} values */
const bucket = (values) => ({
  start: "2026-10-01",
  end: "2026-10-08",
  partial: false,
  noData: false,
  ...values,
});

/**
 * Every Insights reply, by route; the shape test walks this list.
 * @type {Record<string, { status?: number, json: any }>}
 */
export const insightsReplies = {
  "GET reporting/overview": {
    json: {
      meta: meta(OCTOBER),
      totals: { activity, response },
      comparison,
      siteCount: 1,
      sites: [
        {
          ...dims,
          activity,
          response,
          maxSeverity: 4,
          publicContact: contact("available"),
          siteContact: contact("missing"),
          manageHref: "/sites/s1",
        },
      ],
      nextCursor: null,
    },
  },
  "GET reporting/sites/{siteId}": {
    json: {
      meta: meta(OCTOBER),
      site: { ...dims, manageHref: "/sites/s1" },
      publicContact: contact("available"),
      siteContact: contact("missing"),
      totals: { activity, response },
      comparison,
      days: [{ day: "2026-10-01", ...metrics }],
    },
  },
  "GET reporting/issues": {
    json: {
      meta: meta(OCTOBER),
      total: 1,
      issues: [{ ...issue, siteName: "Example Site" }],
      nextCursor: null,
    },
  },
  "GET reporting/issues/{issueId}": {
    json: { meta: meta(null), issue, check, site: siteRef },
  },
  "GET reporting/checks": {
    json: {
      meta: meta(OCTOBER),
      total: 1,
      checks: [{ ...check, siteName: "Example Site" }],
      nextCursor: null,
    },
  },
  "GET reporting/checks/{checkId}": {
    json: { meta: meta(null), check, issues: [issue], site: siteRef },
  },
  "GET reporting/scope-options": {
    json: {
      meta: meta(null),
      groups: Object.fromEntries(
        [
          "status",
          "siteType",
          "providerId",
          "programId",
          "department",
          "managerId",
        ].map((dim) => [
          dim,
          [{ value: String(/** @type {any} */ (dims)[dim]), sites: 1 }],
        ]),
      ),
      categories: [issue.category],
      sites: [dims],
    },
  },
  "POST reporting/trends": {
    json: {
      meta: meta(OCTOBER),
      scope: { siteCount: 1, siteIds: [SITE_ID] },
      comparison,
      series: {
        granularity: "week",
        current: [bucket(metrics)],
        prior: [bucket(metrics)],
      },
      categories: [{ category: "Unsecured gate", issues: 2, severeIssues: 2 }],
      breakdown: [
        {
          value: "Example Department",
          sites: 1,
          current: metrics,
          prior: metrics,
        },
      ],
    },
  },
  "POST reporting/exports": { status: 202, json: { job: job("queued") } },
  "POST reports/insights": {
    status: 202,
    json: {
      job: {
        ...job("queued"),
        kind: "report",
        request: { siteIds: [SITE_ID], period: "month", month: "2026-10" },
      },
    },
  },
  "GET reports/{jobId}": { json: { job: job("succeeded") } },
  "DELETE reports/{jobId}": { json: { job: job("cancelled") } },
};

const ROUTES = Object.keys(insightsReplies).map((key) => {
  const [method, pattern] = key.split(" ");
  return {
    key,
    method,
    regex: new RegExp(`^${pattern.replace(/\{[^}]+\}/g, "[^/]+")}$`),
  };
});

// IDs the mock knows; any other gets the backend's 404, so not-found pages
// can be tested.
const KNOWN = [
  {
    regex: /^reporting\/sites\/([^/]+)$/,
    id: SITE_ID,
    error: "site_not_found",
  },
  { regex: /^reporting\/issues\/([^/]+)$/, id: "t1", error: "issue_not_found" },
  { regex: /^reporting\/checks\/([^/]+)$/, id: "c1", error: "check_not_found" },
  {
    regex: /^reports\/(?!insights$)([^/]+)$/,
    id: "mock-job",
    error: "job_not_found",
  },
];

/**
 * A malformed escape is just an unknown ID, not a crash in the mock.
 * @param {string} part
 */
function decoded(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The Insights reply for a request, or undefined when it isn't an Insights
 * route.
 * @param {{ method: string, path: string }} request path after /admin/v1/
 * @returns {{ status?: number, json: any } | undefined}
 */
export function insightsReply(request) {
  const found = ROUTES.find(
    (r) => r.method === request.method && r.regex.test(request.path),
  );
  if (!found) return undefined;
  for (const known of KNOWN) {
    const match = known.regex.exec(request.path);
    if (match && decoded(match[1]) !== known.id)
      return { status: 404, json: { error: known.error } };
  }
  // A copy, so a spec that edits its reply can't change the next test's.
  return JSON.parse(JSON.stringify(insightsReplies[found.key]));
}
