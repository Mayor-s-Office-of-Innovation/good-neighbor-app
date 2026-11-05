// The fake Insights reporting API for admin specs. Replies copy the shape of
// backend/src/handlers/admin-reporting.js; a backend unit test compares the
// two (reporting/api/insights-mock-shape.test.js), so a changed reply fails
// there before a spec passes against an outdated fake. Overview follows the
// request's period, filters and sort; Site replies follow the period, and
// Issue lists only the period and siteIds, so specs can check what the page
// asked for.

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

const EVALUATED_DAY = "2026-11-04";
const EVALUATED_AT = "2026-11-04T19:00:00.000Z";
const COVERAGE_START = "2026-01-01";

/** @param {string} day @param {number} months */
function addMonths(day, months) {
  const [y, m] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1 + months, 1));
  return next.toISOString().slice(0, 10);
}

/** @param {string} day @param {number} months same day, or the month's last */
function addMonthsSameDay(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last)))
    .toISOString()
    .slice(0, 10);
}

/** @param {string} day @param {number} days */
function addDays(day, days) {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/**
 * The period a request names, as the handler resolves it, or an error code.
 * Instants use 07:00Z, Pacific midnight in summer time, all year; pages
 * read only the day keys.
 * @param {URLSearchParams} params
 * @returns {ReturnType<typeof interval> | { error: string }}
 */
function requestedPeriod(params) {
  const kind = params.get("period") || "month";
  /** @type {[string, string]} */
  let days;
  if (kind === "month") {
    // The last full month, as the handler defaults.
    const month =
      params.get("month") ??
      addMonths(`${EVALUATED_DAY.slice(0, 7)}-01`, -1).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return { error: "invalid_month" };
    days = [`${month}-01`, addMonths(`${month}-01`, 1)];
  } else if (kind === "quarter") {
    // The handler's own checks, so a spec can't pass on a quarter it refuses.
    const year = Number(params.get("year"));
    const quarter = params.get("quarter") ?? "";
    if (!/^2\d{3}$/.test(params.get("year") ?? ""))
      return { error: "invalid_year" };
    if (!/^[1-4]$/.test(quarter)) return { error: "invalid_quarter" };
    const start = `${year}-${String(Number(quarter) * 3 - 2).padStart(2, "0")}-01`;
    days = [start, addMonths(start, 3)];
  } else if (kind === "year" || kind === "financialYear") {
    const year = Number(params.get(kind === "year" ? "year" : "startYear"));
    if (!Number.isInteger(year) || year < 2000)
      return { error: "invalid_year" };
    days =
      kind === "year"
        ? [`${year}-01-01`, `${year + 1}-01-01`]
        : [`${year}-07-01`, `${year + 1}-07-01`];
  } else if (kind === "custom") {
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return { error: "invalid_day" };
    if (to <= from) return { error: "empty_period" };
    if (to > addMonthsSameDay(from, 12)) return { error: "period_too_long" };
    days = [from, to];
  } else return { error: "invalid_period" };
  if (days[0] > EVALUATED_DAY) return { error: "future_period" };
  const found = interval(
    days[0],
    days[1],
    `${days[0]}T07:00:00.000Z`,
    `${days[1]}T07:00:00.000Z`,
  );
  const incomplete = days[1] > EVALUATED_DAY;
  return {
    ...found,
    kind,
    incomplete,
    observedTo: incomplete ? EVALUATED_AT : found.to,
  };
}

/** @param {ReturnType<typeof interval> | null} period */
const meta = (period) => ({
  apiVersion: "reporting-v2",
  contractVersion: "insights-v3",
  ruleVersion: "2026-11-04",
  snapshotId: "mock-snapshot",
  asOf: "2026-11-04T18:00:00.000Z",
  evaluatedAt: EVALUATED_AT,
  timezone: TZ,
  interval: period,
  dataQuality: {
    state: period && period.startDay < COVERAGE_START ? "partial" : "ok",
    reasons:
      period && period.startDay < COVERAGE_START ? ["before_coverage"] : [],
    coverageStart: COVERAGE_START,
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
  sameDaysAsTotals: true,
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

/**
 * The Sites Overview lists. Example Site is the Manage fixture's s1; the
 * others cover each concern and an unknown, with their reasons as the
 * handler would list them.
 */
const SITES = [
  {
    ...dims,
    activity,
    response,
    maxSeverity: 4,
    // 62 Checks over October's 31 days, against its own 4 a day.
    checksPerDay: 2,
    checksOwedPerDay: 4,
    longUnresolved: 1,
    publicContact: contact("available"),
    siteContact: contact("missing"),
    concerns: [
      "fewChecks",
      "repeatedSevere",
      "manyIssues",
      "longUnresolved",
      "overdue",
      "late",
    ],
    unknownEvidence: [],
  },
  {
    ...dims,
    siteId: "s2",
    name: "Quiet Site",
    status: "inactive",
    providerId: "v2",
    programId: "p2",
    activity: {
      completedPerimeterChecks: 0,
      singleIssueReports: 0,
      unfinishedChecks: 0,
      issuesCreated: 0,
      severeIssues: 0,
    },
    response: {
      awaiting: 0,
      overdue: 0,
      onTime: 0,
      late: 0,
      unknown: 0,
      notTimed: 0,
    },
    maxSeverity: null,
    // Closed, so no Checks isn't a concern.
    checksPerDay: 0,
    checksOwedPerDay: 3,
    longUnresolved: 0,
    publicContact: contact("available"),
    siteContact: contact("available"),
    concerns: [],
    unknownEvidence: [],
  },
  {
    ...dims,
    siteId: "s3",
    name: "Harbor Example Site",
    activity: {
      completedPerimeterChecks: 93,
      singleIssueReports: 1,
      unfinishedChecks: 0,
      issuesCreated: 2,
      severeIssues: 0,
    },
    response: {
      awaiting: 1,
      overdue: 0,
      onTime: 1,
      late: 0,
      unknown: 0,
      notTimed: 0,
    },
    maxSeverity: 2,
    checksPerDay: 3,
    checksOwedPerDay: 3,
    longUnresolved: 0,
    publicContact: contact("available"),
    siteContact: contact("available"),
    concerns: [],
    unknownEvidence: [],
  },
  {
    ...dims,
    siteId: "s4",
    name: "Pier Example Site",
    managerId: "pm2",
    department: "Other Department",
    activity: {
      completedPerimeterChecks: 12,
      singleIssueReports: 0,
      unfinishedChecks: 2,
      issuesCreated: 3,
      severeIssues: 1,
    },
    response: {
      awaiting: 0,
      overdue: 0,
      onTime: 1,
      late: 1,
      unknown: 1,
      notTimed: 0,
    },
    maxSeverity: 5,
    checksPerDay: 0.4,
    checksOwedPerDay: 3,
    longUnresolved: 0,
    publicContact: contact("missing"),
    siteContact: contact("unknown"),
    concerns: ["fewChecks", "late"],
    unknownEvidence: ["response", "siteContact"],
  },
];

/** @param {Record<string, number>} counts */
const zeros = (counts) =>
  Object.fromEntries(Object.keys(counts).map((k) => [k, 0]));
// Its own zeros, frozen because rows share them: a write would change every
// later total, so it throws instead.
const ZERO = Object.freeze({
  activity: Object.freeze(zeros(activity)),
  response: Object.freeze(zeros(response)),
});

const collator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true,
});
/**
 * The handler's name order: as people read numbers, then exact text, then
 * siteId, so equal names still come out the same way every time.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 */
const byName = (a, b) =>
  collator.compare(a.name, b.name) ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
  (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0);

/** @param {Record<string, any>} site @param {ReturnType<typeof interval>} period */
const counted = (site, period) =>
  period.endDay <= COVERAGE_START
    ? {
        ...site,
        ...ZERO,
        maxSeverity: null,
        checksPerDay: null,
        checksOwedPerDay: null,
        longUnresolved: 0,
        // No activity data, so only today's contacts can still be unknown.
        concerns: [],
        unknownEvidence: site.unknownEvidence.filter(
          (/** @type {string} */ u) => u.endsWith("Contact"),
        ),
      }
    : site;

/** @param {Record<string, any>[]} rows */
function totalsOf(rows) {
  /** @type {Record<string, Record<string, number>>} */
  const sums = {
    activity: { ...ZERO.activity },
    response: { ...ZERO.response },
  };
  for (const row of rows)
    for (const part of /** @type {const} */ (["activity", "response"]))
      for (const [k, v] of Object.entries(row[part])) sums[part][k] += v;
  return sums;
}

const SITE_FILTERS = [
  "siteType",
  "providerId",
  "programId",
  "department",
  "managerId",
  "status",
];
const SORT_VALUE = {
  /** @param {any} r */ name: (r) => r.name,
  /** @param {any} r */ overdueLate: (r) =>
    r.response.overdue + r.response.late,
  /** @param {any} r */ maxSeverity: (r) => r.maxSeverity,
  /** @param {any} r */ completedPerimeterChecks: (r) =>
    r.activity.completedPerimeterChecks,
  /** @param {any} r */ issuesCreated: (r) => r.activity.issuesCreated,
};

/**
 * Overview for a request, filtered and sorted as the handler does, every Site at once.
 * @param {URLSearchParams} params
 */
function overviewReply(params) {
  const period = requestedPeriod(params);
  if ("error" in period) return { status: 400, json: { error: period.error } };
  // An empty value is refused, as the handler refuses it, not defaulted.
  const sort = params.has("sort") ? String(params.get("sort")) : "name";
  if (!Object.hasOwn(SORT_VALUE, sort))
    return { status: 400, json: { error: "invalid_sort" } };
  const value = SORT_VALUE[/** @type {keyof typeof SORT_VALUE} */ (sort)];
  const dir = params.has("dir")
    ? params.get("dir")
    : sort === "name"
      ? "asc"
      : "desc";
  if (dir !== "asc" && dir !== "desc")
    return { status: 400, json: { error: "invalid_dir" } };
  const q = (params.get("q") || "").trim().toLowerCase();
  const ids = params.get("siteIds")?.split(",");
  const show = params.get("show") || "all";
  const state = params.get("responseState");
  const rows = SITES.map((site) => counted(site, period)).filter(
    (r) =>
      (!q ||
        r.name.toLowerCase().includes(q) ||
        r.siteId.toLowerCase().includes(q)) &&
      (!ids || ids.includes(r.siteId)) &&
      SITE_FILTERS.every((k) => !params.get(k) || params.get(k) === r[k]) &&
      (show === "all" ||
        (show === "top" ? r.concerns : r.unknownEvidence).length > 0) &&
      (!state || r.response[state] > 0) &&
      (!params.get("publicContact") ||
        params.get("publicContact") === r.publicContact.state) &&
      (!params.get("siteContact") ||
        params.get("siteContact") === r.siteContact.state),
  );
  rows.sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    // Blanks sort last either way, then by name, as the handler's do.
    if (x === null || y === null)
      return (x === null ? 1 : 0) - (y === null ? 1 : 0) || byName(a, b);
    const order = typeof x === "string" ? collator.compare(x, y) : x - y;
    return (dir === "asc" ? order : -order) || byName(a, b);
  });
  return {
    json: {
      meta: meta(period),
      totals: totalsOf(rows),
      comparison,
      siteCount: rows.length,
      sites: rows.map((r) => ({ ...r, manageHref: `/sites/${r.siteId}` })),
    },
  };
}

/**
 * @param {string} siteId
 * @param {URLSearchParams} params
 */
function siteReply(siteId, params) {
  const site = SITES.find((s) => s.siteId === siteId);
  if (!site) return { status: 404, json: { error: "site_not_found" } };
  const period = requestedPeriod(params);
  if ("error" in period) return { status: 400, json: { error: period.error } };
  const row = counted(site, period);
  const today = addDays(EVALUATED_DAY, 1);
  const last = period.endDay < today ? period.endDay : today;
  const first =
    period.startDay > COVERAGE_START ? period.startDay : COVERAGE_START;
  /** @type {Record<string, any>[]} */
  const days = [];
  for (let day = first; day < last; day = addDays(day, 1))
    days.push({ day, ...ZERO.activity, ...ZERO.response });
  // One busy day holds the period's counts, so the day table has a row to read.
  if (days.length) Object.assign(days[0], row.activity, row.response);
  const dimsOnly = Object.fromEntries(
    Object.keys(dims).map((k) => [k, /** @type {any} */ (row)[k]]),
  );
  return {
    json: {
      meta: meta(period),
      site: { ...dimsOnly, manageHref: `/sites/${siteId}` },
      publicContact: row.publicContact,
      siteContact: row.siteContact,
      totals: { activity: row.activity, response: row.response },
      checksPerDay: row.checksPerDay,
      checksOwedPerDay: row.checksOwedPerDay,
      longUnresolved: row.longUnresolved,
      concerns: row.concerns,
      comparison,
      days,
    },
  };
}

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

/** Issues by Site: two of s1's, one Overdue, and one for s4 with no response record. */
const ISSUES = [
  { ...issue, siteName: "Example Site" },
  {
    ...issue,
    issueId: "t2",
    siteName: "Example Site",
    category: "Fence damage",
    severity: 3,
    severityBand: "moderate",
    createdAt: "2026-10-20T16:00:00.000Z",
    createdDay: "2026-10-20",
    deadlineAt: "2026-10-23T16:00:00.000Z",
    firstResponseAt: null,
    responseState: "overdue",
    latestActivityAt: "2026-10-20T16:00:00.000Z",
  },
  {
    ...issue,
    issueId: "t9",
    siteId: "s4",
    siteName: "Pier Example Site",
    category: "Debris",
    severity: 2,
    severityBand: "minor",
    firstResponseAt: null,
    responseState: "unknown",
    responseBasis: null,
    // No Check is on record for it, so its source isn't known either.
    checkId: null,
    source: "unknown",
    latestActivityAt: issue.createdAt,
  },
];

/**
 * One Issue's record, with its Check when it has one, as issueDetail gives.
 * @param {string} issueId
 * @returns {{ status?: number, json: any }}
 */
function issueRecord(issueId) {
  const listed = ISSUES.find((i) => i.issueId === issueId);
  if (!listed) return { status: 404, json: { error: "issue_not_found" } };
  // The list row carries its Site's name; the record names it under site.
  const found = Object.fromEntries(
    Object.entries(listed).filter(([key]) => key !== "siteName"),
  );
  const site = SITES.find((s) => s.siteId === found.siteId);
  return {
    json: {
      meta: meta(null),
      issue: found,
      check: found.checkId === check.checkId ? check : null,
      site: {
        siteId: found.siteId,
        name: site?.name ?? null,
        manageHref: `/sites/${found.siteId}`,
      },
    },
  };
}

/** @param {URLSearchParams} params */
function issuesReply(params) {
  const period = requestedPeriod(params);
  if ("error" in period) return { status: 400, json: { error: period.error } };
  const ids = params.get("siteIds")?.split(",");
  const state = params.get("responseState");
  const rows = ISSUES.filter(
    (i) =>
      (!ids || ids.includes(i.siteId)) &&
      (!state || i.responseState === state) &&
      i.createdDay >= period.startDay &&
      i.createdDay < period.endDay,
  );
  return {
    json: {
      meta: meta(period),
      total: rows.length,
      issues: rows,
      nextCursor: null,
    },
  };
}

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
  partialCoverage: false,
  ...values,
});

/**
 * Every Insights reply, by route; the shape test walks this list.
 * @type {Record<string, { status?: number, json: any }>}
 */
export const insightsReplies = {
  "GET reporting/overview": overviewReply(
    new URLSearchParams("period=month&month=2026-10"),
  ),
  "GET reporting/sites/{siteId}": siteReply(
    SITE_ID,
    new URLSearchParams("period=month&month=2026-10"),
  ),
  "GET reporting/issues": issuesReply(
    new URLSearchParams("period=month&month=2026-10"),
  ),
  // The reply the mock really sends, so the shape test checks it.
  "GET reporting/issues/{issueId}": issueRecord("t1"),
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
    keys: ["GET reporting/checks/{checkId}"],
    ids: ["c1"],
    error: "check_not_found",
  },
  {
    // POST reports/insights is its own route, so "insights" is never a job.
    keys: ["GET reports/{jobId}", "DELETE reports/{jobId}"],
    ids: ["mock-job"],
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
 * @param {{ method: string, path: string, search?: string }} request path after /admin/v1/
 * @returns {{ status?: number, json: any } | undefined}
 */
export function insightsReply(request) {
  const found = ROUTES.find(
    (r) => r.method === request.method && r.regex.test(request.path),
  );
  if (!found) return undefined;
  const params = new URLSearchParams(request.search || "");
  // A copy, so a spec that edits its reply can't change the next test's.
  /** @param {{ status?: number, json: any }} reply */
  const copy = (reply) => JSON.parse(JSON.stringify(reply));
  if (found.key === "GET reporting/overview")
    return copy(overviewReply(params));
  if (found.key === "GET reporting/issues") return copy(issuesReply(params));
  if (found.key === "GET reporting/scope-options") {
    const reply = copy(insightsReplies[found.key]);
    if (params.get("include") === "sites")
      reply.json.sites = SITES.map(({ siteId, name }) => ({ siteId, name }));
    return reply;
  }
  if (found.key === "GET reporting/sites/{siteId}")
    return copy(
      siteReply(decoded(request.path.split("/").pop() || ""), params),
    );
  const id = decoded(request.path.split("/").pop() || "");
  if (found.key === "GET reporting/issues/{issueId}")
    return copy(issueRecord(id));
  const known = KNOWN.find((k) => k.keys.includes(found.key));
  if (known && !known.ids.includes(id))
    return { status: 404, json: { error: known.error } };
  return copy(insightsReplies[found.key]);
}
