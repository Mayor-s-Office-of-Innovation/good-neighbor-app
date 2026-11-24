// The fake Insights reporting API for admin specs. Replies copy the shape of
// backend/src/handlers/admin-reporting.js; a backend unit test compares the
// two (reporting/api/insights-mock-shape.test.js), so a changed reply fails
// there before a spec passes against an outdated fake. Requests go through
// the backend's own parsers, so the fake refuses what the handler refuses.
// Overview and Issue lists apply every filter and sort; Site rows, rates and
// concerns follow the period.

import {
  addDays,
  dayKeysBetween,
} from "../../backend/src/lib/pacific-dates.js";
import { comparisonFor } from "../../backend/src/reporting/periods.js";
import {
  SITE_ROW_FILTERS,
  concernsOf,
  issueMatches,
  sortRows,
  sortSiteRows,
} from "../../backend/src/reporting/api/read-model.js";
import {
  SITE_DIMENSIONS,
  decodeCursor,
  encodeCursor,
  isRequestError,
  parseListQuery,
  parsePeriodParams,
  parseSiteFilter,
} from "../../backend/src/reporting/api/requests.js";

/** @typedef {import("../../backend/src/reporting/periods.js").Interval} Interval */

const TZ = "America/Los_Angeles";
const SITE_ID = "s1";
const SNAPSHOT_ID = "mock-snapshot";
const EVALUATED_DAY = "2026-11-04";
const EVALUATED_AT = "2026-11-04T19:00:00.000Z";
const COVERAGE_START = "2026-01-01";
// The fake has data every day, so the default month is the handler's.
const DATA_DAYS = dayKeysBetween(COVERAGE_START, addDays(EVALUATED_DAY, 1));

/**
 * The period a request names, resolved by the handler's own parser.
 * @param {Record<string, string>} query
 * @returns {Interval}
 */
const requestedPeriod = (query) =>
  parsePeriodParams(query, EVALUATED_AT, DATA_DAYS);

const OCTOBER = requestedPeriod({ period: "month", month: "2026-10" });

/** @param {Interval | null} period */
const meta = (period) => ({
  apiVersion: "reporting-v3",
  contractVersion: "insights-v4",
  ruleVersion: "2026-11-04",
  snapshotId: SNAPSHOT_ID,
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
      openSitesWithoutTerms: 0,
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

// The period's own comparison days; the counts stay made up.
/** @param {Interval} period */
const comparison = (period) => {
  const cmp = comparisonFor(period, EVALUATED_AT);
  return {
    ...cmp,
    sameDaysAsTotals: cmp.basis === "complete_period",
    priorCoverage: !cmp.prior
      ? null
      : cmp.prior.startDay >= COVERAGE_START
        ? "full"
        : cmp.prior.endDay <= COVERAGE_START
          ? "none"
          : "partial",
    change: cmp.prior
      ? Object.fromEntries(
          Object.entries(metrics).map(([k, v]) => [
            k,
            { current: v, prior: v - 1, change: 1 },
          ]),
        )
      : null,
  };
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
    checksPerOwedDay: 2,
    longUnresolved: 1,
    publicContact: contact("available"),
    siteContact: contact("missing"),
    concerns: ["fewChecks", "repeatedSevere", "manyIssues", "slowResponse"],
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
    checksPerOwedDay: 0,
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
    checksPerOwedDay: 3,
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
    checksPerOwedDay: 0.4,
    // t9 has no response record and is open since Oct 2.
    longUnresolved: 1,
    publicContact: contact("missing"),
    siteContact: contact("unknown"),
    concerns: ["fewChecks", "slowResponse"],
    unknownEvidence: ["response", "siteContact"],
  },
];

// Each Site's Issues by severity band, adding up to its issuesCreated and severeIssues.
/** @type {Record<string, Record<string, number>>} */
const SEVERITY = {
  s1: { minor: 4, moderate: 3, severe: 2, unknown: 0 },
  s3: { minor: 2, moderate: 0, severe: 0, unknown: 0 },
  s4: { minor: 1, moderate: 1, severe: 1, unknown: 0 },
};

/** @param {Record<string, number>} counts */
const zeros = (counts) =>
  Object.fromEntries(Object.keys(counts).map((k) => [k, 0]));
// Its own zeros, frozen because rows share them: a write would change every
// later total, so it throws instead.
const ZERO = Object.freeze({
  activity: Object.freeze(zeros(activity)),
  response: Object.freeze(zeros(response)),
});

// Every fake count happened on this day, so a period without it has none.
const BUSY_DAY = "2026-10-02";

/** @param {string} a @param {string} b */
const earlier = (a, b) => (a < b ? a : b);
/** @param {number} n */
const oneDecimal = (n) => Math.round(n * 10) / 10;

/**
 * A Site's row for a period, with its rates and concerns worked out as the
 * handler does: averages from the day after the records begin, and Issues per
 * 30 days counting today.
 * @param {Record<string, any>} site October's counts, all on BUSY_DAY
 * @param {Interval} period
 * @returns {Record<string, any>}
 */
const counted = (site, period) => {
  const busy = period.startDay <= BUSY_DAY && BUSY_DAY < period.endDay;
  const row = busy
    ? site
    : {
        ...site,
        ...ZERO,
        maxSeverity: null,
        longUnresolved: 0,
        // No Issues, so only today's contacts can still be unknown.
        unknownEvidence: site.unknownEvidence.filter(
          (/** @type {string} */ u) => u.endsWith("Contact"),
        ),
      };
  const first =
    period.startDay > COVERAGE_START
      ? period.startDay
      : addDays(COVERAGE_START, 1);
  /** @param {string} end */
  const daysTo = (end) => (first < end ? dayKeysBetween(first, end).length : 0);
  const wholeDays = daysTo(earlier(period.endDay, EVALUATED_DAY));
  const issueDays = daysTo(earlier(period.endDay, addDays(EVALUATED_DAY, 1)));
  const checksPerDay = wholeDays
    ? oneDecimal(row.activity.completedPerimeterChecks / wholeDays)
    : null;
  const issuesPer30Days = issueDays
    ? oneDecimal((row.activity.issuesCreated * 30) / Math.max(issueDays, 30))
    : null;
  const underOwed =
    checksPerDay !== null &&
    row.checksOwedPerDay !== null &&
    checksPerDay < row.checksOwedPerDay;
  return {
    ...row,
    checksPerDay,
    checksPerOwedDay: row.checksOwedPerDay === null ? null : checksPerDay,
    issuesPer30Days,
    concerns: concernsOf(
      {
        totals: { activity: row.activity, response: row.response },
        underOwed,
        longUnresolved: row.longUnresolved,
        issuesPer30Days,
      },
      row.status !== "inactive",
    ),
  };
};

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

/**
 * The Sites a request's Site filter keeps, as matchSites keeps them.
 * @param {Record<string, any>} site
 * @param {import("../../backend/src/reporting/api/requests.js").SiteFilter} filter
 */
function siteMatches(site, filter) {
  const q = filter.q?.toLocaleLowerCase("en-US");
  return (
    (!filter.siteIds || filter.siteIds.includes(site.siteId)) &&
    SITE_DIMENSIONS.every((dim) => {
      const want = /** @type {Record<string, unknown>} */ (filter)[dim];
      return want === undefined || site[dim] === want;
    }) &&
    (!q ||
      site.name.toLocaleLowerCase("en-US").includes(q) ||
      site.siteId.toLocaleLowerCase("en-US").includes(q))
  );
}

/**
 * Overview for a request, filtered and sorted as the handler does, every Site at once.
 * @param {Record<string, string>} query
 */
function overviewReply(query) {
  const period = requestedPeriod(query);
  const filter = parseSiteFilter(query);
  const list = parseListQuery("sites", query);
  const rows = SITES.map((site) => counted(site, period)).filter(
    (r) =>
      siteMatches(r, filter) &&
      Object.entries(list.filters).every(([name, value]) =>
        SITE_ROW_FILTERS[name](r, value),
      ),
  );
  return {
    json: {
      meta: meta(period),
      totals: totalsOf(rows),
      comparison: comparison(period),
      siteCount: rows.length,
      sites: sortSiteRows(rows, list.sort).map((r) => ({
        ...r,
        manageHref: `/sites/${r.siteId}`,
      })),
    },
  };
}

/**
 * @param {string} siteId
 * @param {Record<string, string>} query
 */
function siteReply(siteId, query) {
  // The handler reads the period first, so a bad one is a 400 even for an unknown Site.
  const period = requestedPeriod(query);
  const site = SITES.find((s) => s.siteId === siteId);
  if (!site) return { status: 404, json: { error: "site_not_found" } };
  const row = counted(site, period);
  const today = addDays(EVALUATED_DAY, 1);
  const last = period.endDay < today ? period.endDay : today;
  const first =
    period.startDay > COVERAGE_START ? period.startDay : COVERAGE_START;
  /** @type {Record<string, any>[]} */
  const days = [];
  for (let day = first; day < last; day = addDays(day, 1))
    days.push({ day, ...ZERO.activity, ...ZERO.response });
  const busy = days.find((d) => d.day === BUSY_DAY);
  if (busy) Object.assign(busy, row.activity, row.response);
  const dimsOnly = Object.fromEntries(
    Object.keys(dims).map((k) => [k, /** @type {any} */ (row)[k]]),
  );
  return {
    json: {
      meta: meta(period),
      site: { ...dimsOnly, manageHref: `/sites/${siteId}` },
      publicContact: {
        ...row.publicContact,
        email:
          row.publicContact.state === "available" ? "desk@example.org" : null,
        phone: row.publicContact.state === "available" ? "415-555-0100" : null,
        phoneExtension: null,
      },
      siteContact: row.siteContact,
      totals: {
        activity: row.activity,
        response: row.response,
        severity:
          row.activity.issuesCreated && SEVERITY[siteId]
            ? SEVERITY[siteId]
            : zeros(SEVERITY.s1),
      },
      checksPerDay: row.checksPerDay,
      checksOwedPerDay: row.checksOwedPerDay,
      checksPerOwedDay: row.checksPerOwedDay,
      issuesPer30Days: row.issuesPer30Days,
      longUnresolved: row.longUnresolved,
      concerns: row.concerns,
      comparison: comparison(period),
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

// A 1×1 image, so no spec waits on a file the fake doesn't serve.
const PIXEL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";

/**
 * @param {string} artifactId
 * @param {"check" | "update"} source
 * @param {string} takenAt
 */
const photo = (artifactId, source, takenAt) => ({
  artifactId,
  source,
  takenAt,
  thumbnailUrl: PIXEL,
  url: PIXEL,
  urlExpiresAt: "2026-11-04T19:05:00.000Z",
  urlSeconds: 300,
});
const CHECK_PHOTO = photo("art-1", "check", "2026-10-02T17:01:00.000Z");

/**
 * A record's photos and notes, with the refusals the record-photos handler
 * gives. Only t1 and its Check have any, so the others show the empty state.
 * @param {string} siteId
 * @param {URLSearchParams} params
 * @returns {{ status?: number, json: any }}
 */
export function recordPhotosReply(siteId, params) {
  const checkId = params.get("checkId");
  const issueId = params.get("issueId");
  if (Boolean(checkId) === Boolean(issueId))
    return { status: 400, json: { error: "check_or_issue_required" } };
  if (checkId)
    return checkId === check.checkId && siteId === check.siteId
      ? {
          json: {
            photos: [CHECK_PHOTO],
            notes: [
              {
                source: "check",
                at: "2026-10-02T17:02:00.000Z",
                text: "Synthetic description",
              },
            ],
          },
        }
      : { status: 404, json: { error: "check_not_found" } };
  if (!ISSUES.some((i) => i.issueId === issueId && i.siteId === siteId))
    return { status: 404, json: { error: "issue_not_found" } };
  if (issueId !== issue.issueId) return { json: { photos: [], notes: [] } };
  return {
    json: {
      photos: [
        CHECK_PHOTO,
        photo("t1-u2-p1", "update", "2026-10-03T17:00:00.000Z"),
      ],
      notes: [
        {
          source: "update",
          at: "2026-10-03T17:00:00.000Z",
          text: "Synthetic note",
        },
      ],
    },
  };
}

/**
 * Issues for a request, filtered, sorted and paged as listIssues does.
 * @param {Record<string, string>} query
 */
function issuesReply(query) {
  const period = requestedPeriod(query);
  const filter = parseSiteFilter(query);
  const list = parseListQuery("issues", query);
  const sites = new Set(
    SITES.filter((s) => siteMatches(s, filter)).map((s) => s.siteId),
  );
  const rows = sortRows(
    ISSUES.filter(
      (i) =>
        sites.has(i.siteId) &&
        i.createdDay >= period.startDay &&
        i.createdDay < period.endDay &&
        issueMatches(i, list.filters, Date.parse(EVALUATED_AT)),
    ),
    list.sort,
    ["siteId", "issueId"],
  );
  const key = {
    kind: "issues",
    period: { startDay: period.startDay, endDay: period.endDay },
    filter,
    filters: list.filters,
    sort: list.sort,
    limit: list.limit,
  };
  const offset = list.cursor ? decodeCursor(list.cursor, key, SNAPSHOT_ID) : 0;
  const next = offset + list.limit;
  return {
    json: {
      meta: meta(period),
      total: rows.length,
      issues: rows.slice(offset, next),
      nextCursor:
        next < rows.length ? encodeCursor(key, SNAPSHOT_ID, next) : null,
    },
  };
}

/**
 * Checks for a request, filtered as listChecks does; the fake has one Check.
 * @param {Record<string, string>} query
 */
function checksReply(query) {
  const period = requestedPeriod(query);
  const filter = parseSiteFilter(query);
  const { filters } = parseListQuery("checks", query);
  const sites = new Set(
    SITES.filter((s) => siteMatches(s, filter)).map((s) => s.siteId),
  );
  const rows = [{ ...check, siteName: "Example Site" }].filter(
    (c) =>
      sites.has(c.siteId) &&
      c.day >= period.startDay &&
      c.day < period.endDay &&
      (!filters.state || c.state === filters.state) &&
      (!filters.source || c.source === filters.source),
  );
  return {
    json: {
      meta: meta(period),
      total: rows.length,
      checks: rows,
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
  downloadSeconds: state === "succeeded" ? 300 : null,
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

const OCTOBER_QUERY = { period: "month", month: "2026-10" };

/**
 * Every Insights reply, by route; the shape test walks this list.
 * @type {Record<string, { status?: number, json: any }>}
 */
export const insightsReplies = {
  "GET reporting/overview": overviewReply(OCTOBER_QUERY),
  "GET reporting/sites/{siteId}": siteReply(SITE_ID, OCTOBER_QUERY),
  "GET reporting/issues": issuesReply(OCTOBER_QUERY),
  // The reply the mock really sends, so the shape test checks it.
  "GET reporting/issues/{issueId}": issueRecord("t1"),
  "GET reporting/checks": checksReply(OCTOBER_QUERY),
  "GET reporting/checks/{checkId}": {
    json: { meta: meta(null), check, issues: [issue], site: siteRef },
  },
  "GET reporting/scope-options": {
    json: {
      meta: meta(null),
      // Every fake Site, counted per value as the handler counts them.
      groups: Object.fromEntries(
        [
          "status",
          "siteType",
          "providerId",
          "programId",
          "department",
          "managerId",
        ].map((dim) => {
          /** @type {Map<string, number>} */
          const counts = new Map();
          for (const site of SITES) {
            const value = String(/** @type {any} */ (site)[dim]);
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          return [
            dim,
            [...counts]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([value, sites]) => ({ value, sites })),
          ];
        }),
      ),
      categories: [issue.category],
      // Only with include=sites; insightsReply drops it otherwise.
      sites: SITES.map(({ siteId, name }) => ({ siteId, name })),
    },
  },
  "POST reporting/trends": {
    json: {
      meta: meta(OCTOBER),
      scope: { siteCount: 1, siteIds: [SITE_ID] },
      comparison: comparison(OCTOBER),
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
  /** @type {Record<string, string>} */
  const query = Object.fromEntries(new URLSearchParams(request.search || ""));
  // A copy, so a spec that edits its reply can't change the next test's.
  /** @param {{ status?: number, json: any }} reply */
  const copy = (reply) => JSON.parse(JSON.stringify(reply));
  const id = decoded(request.path.split("/").pop() || "");
  try {
    if (found.key === "GET reporting/overview")
      return copy(overviewReply(query));
    if (found.key === "GET reporting/issues") return copy(issuesReply(query));
    if (found.key === "GET reporting/checks") return copy(checksReply(query));
    if (found.key === "GET reporting/sites/{siteId}")
      return copy(siteReply(id, query));
  } catch (err) {
    // The parsers' refusals, answered as the handler answers them.
    if (isRequestError(err))
      return { status: err.statusCode, json: { error: err.code } };
    throw err;
  }
  if (found.key === "GET reporting/scope-options") {
    const reply = copy(insightsReplies[found.key]);
    if (query.include !== "sites") delete reply.json.sites;
    return reply;
  }
  if (found.key === "GET reporting/issues/{issueId}")
    return copy(issueRecord(id));
  const known = KNOWN.find((k) => k.keys.includes(found.key));
  if (known && !known.ids.includes(id))
    return { status: 404, json: { error: known.error } };
  return copy(insightsReplies[found.key]);
}
