// Counts come as the projection built them, so screens, CSVs and reports can't disagree.

import {
  addDays,
  addMonthsToFirst,
  dayKeysBetween,
  pacificDateKey,
} from "../../lib/pacific-dates.js";
import { SITE_DAY_METRICS, compareTotals, sumSiteDays } from "../activity.js";
import { API_VERSION, CONTRACT_VERSION, RESPONSE_STATES } from "../contract.js";
import { comparisonFor, previousOf } from "../periods.js";
import {
  SITE_DIMENSIONS,
  decodeCursor,
  encodeCursor,
  requestError,
} from "./requests.js";

/** @typedef {import("./snapshot.js").Snapshot} Snapshot */
/** @typedef {import("../periods.js").Interval} Interval */
/** @typedef {import("./requests.js").SiteFilter} SiteFilter */
/** @typedef {import("./requests.js").ListQuery} ListQuery */

const STALE_AFTER_MS = 6 * 3_600_000;
const NAMES = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const NAME_KEYS = new Set(["name", "siteName", "tieName", "sortValue"]);
const ACTIVITY = SITE_DAY_METRICS.filter((m) => !RESPONSE_STATES.includes(m));

/**
 * @param {Snapshot} snap
 * @param {Interval | null} interval
 * @param {number} now
 */
export function dataQuality(snap, interval, now) {
  /** @type {string[]} */
  const reasons = [];
  const asOf = snap.manifest.asOf ? Date.parse(snap.manifest.asOf) : NaN;
  if (!Number.isFinite(asOf)) reasons.push("no_export_time");
  else if (now - asOf > STALE_AFTER_MS) reasons.push("stale_snapshot");
  if (
    interval &&
    (snap.coverageStart === null || interval.startDay < snap.coverageStart)
  )
    reasons.push("before_coverage");
  if (snap.manifest.dataQuality?.undatedChecks > 0)
    reasons.push("undated_checks");
  // Issues with no usable time are left out of every count.
  if (snap.manifest.dataQuality?.undated > 0) reasons.push("undated_issues");
  const partial = reasons.some((r) => r !== "stale_snapshot");
  return {
    state: partial ? "partial" : reasons.length ? "stale" : "ok",
    reasons,
    coverageStart: snap.coverageStart,
    excluded: snap.manifest.dataQuality ?? {},
  };
}

// Every reply carries this, so any number can be traced to its data.
/**
 * @param {Snapshot} snap
 * @param {Interval | null} interval
 * @param {number} now
 */
function meta(snap, interval, now) {
  return {
    apiVersion: API_VERSION,
    contractVersion: CONTRACT_VERSION,
    // Never today's rules: an older snapshot may have been built under others.
    ruleVersion: snap.manifest.ruleVersion ?? null,
    snapshotId: snap.snapshotId,
    asOf: snap.manifest.asOf ?? null,
    evaluatedAt: snap.manifest.evaluatedAt,
    timezone: snap.manifest.timezone,
    interval,
    dataQuality: dataQuality(snap, interval, now),
  };
}

/** @param {string} siteId */
const manageHref = (siteId) => `/sites/${encodeURIComponent(siteId)}`;

/**
 * @param {Snapshot} snap
 * @param {SiteFilter} filter
 * @returns {Record<string, any>[]}
 */
function matchSites(snap, filter) {
  const ids = filter.siteIds ? new Set(filter.siteIds) : null;
  const q = filter.q?.toLocaleLowerCase("en-US");
  return snap.tables.sites.filter(
    (s) =>
      (!ids || ids.has(s.siteId)) &&
      SITE_DIMENSIONS.every((dim) => {
        const want = /** @type {Record<string, unknown>} */ (filter)[dim];
        return want === undefined || s[dim] === want;
      }) &&
      (!q ||
        String(s.name ?? "")
          .toLocaleLowerCase("en-US")
          .includes(q) ||
        s.siteId.toLocaleLowerCase("en-US").includes(q)),
  );
}

/** @param {Record<string, number>} totals */
function split(totals) {
  return {
    activity: Object.fromEntries(ACTIVITY.map((m) => [m, totals[m] ?? 0])),
    response: Object.fromEntries(
      RESPONSE_STATES.map((m) => [m, totals[m] ?? 0]),
    ),
  };
}

/**
 * @param {Record<string, any>[]} rows sorted by day
 * @param {string} day
 * @returns {number} index of the first row on or after `day`
 */
function firstOnOrAfter(rows, day) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].day < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Reads only the range's rows, since Trends asks for one range per week or month.
/**
 * @param {Snapshot} snap
 * @param {{ startDay: string, endDay: string }} range
 * @param {Set<string>} siteIds
 */
function sumDays(snap, range, siteIds) {
  const rows = snap.daysInOrder;
  const slice = rows.slice(
    firstOnOrAfter(rows, range.startDay),
    firstOnOrAfter(rows, range.endDay),
  );
  return sumSiteDays(/** @type {any[]} */ (slice), range, siteIds);
}

/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {Set<string>} siteIds
 */
function comparison(snap, interval, siteIds) {
  const cmp = comparisonFor(interval, snap.manifest.evaluatedAt);
  // A running period's totals count today, which the comparison can't split, so say so.
  const sameDaysAsTotals = cmp.basis === "complete_period";
  if (!cmp.prior)
    return { ...cmp, sameDaysAsTotals, priorCoverage: null, change: null };
  return {
    ...cmp,
    sameDaysAsTotals,
    priorCoverage: priorCoverage(snap, cmp.prior),
    change: compareTotals(
      sumDays(snap, cmp.current, siteIds).total,
      sumDays(snap, cmp.prior, siteIds).total,
    ),
  };
}

// At launch the prior period predates the first record, and a rise against it would look real.
/**
 * @param {Snapshot} snap
 * @param {{ startDay: string, endDay: string }} prior
 * @returns {"full" | "partial" | "none"}
 */
function priorCoverage(snap, prior) {
  if (snap.coverageStart === null || prior.endDay <= snap.coverageStart)
    return "none";
  return prior.startDay < snap.coverageStart ? "partial" : "full";
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @param {string} key
 */
function compareValues(a, b, key) {
  const x = a[key] ?? null;
  const y = b[key] ?? null;
  // Missing values sort last either way, so blanks never lead a list.
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  // Locale order for names only, since the collator is slow; raw order breaks ties.
  if (NAME_KEYS.has(key) && typeof x === "string" && typeof y === "string") {
    const c = NAMES.compare(x, y);
    if (c) return c;
  }
  return x < y ? -1 : x > y ? 1 : 0;
}

// A fixed tie-break keeps every page boundary stable.
/**
 * @template {Record<string, any>} T
 * @param {T[]} rows
 * @param {{ key: string, dir: "asc" | "desc" }} sort
 * @param {string[]} ties
 * @returns {T[]}
 */
function sortRows(rows, sort, ties) {
  const sign = sort.dir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const primary = compareValues(a, b, sort.key);
    const blank = a[sort.key] == null || b[sort.key] == null;
    if (primary) return blank ? primary : primary * sign;
    for (const tie of ties) {
      const c = compareValues(a, b, tie);
      if (c) return c;
    }
    return 0;
  });
}

/**
 * @template T
 * @param {T[]} rows
 * @param {ListQuery} list
 * @param {unknown} query everything that shaped `rows`, for the cursor
 * @param {Snapshot} snap
 * @returns {{ page: T[], nextCursor: string | null, offset: number }}
 */
function paginate(rows, list, query, snap) {
  const offset = list.cursor
    ? decodeCursor(list.cursor, query, snap.snapshotId)
    : 0;
  const page = rows.slice(offset, offset + list.limit);
  const next = offset + list.limit;
  return {
    page,
    offset,
    nextCursor:
      next < rows.length ? encodeCursor(query, snap.snapshotId, next) : null,
  };
}

/** @param {Interval} interval */
const periodKey = (interval) => ({
  startDay: interval.startDay,
  endDay: interval.endDay,
});

/**
 * @param {Snapshot} snap
 * @param {string} siteId
 */
function contacts(snap, siteId) {
  const c = snap.contactsBySite.get(siteId);
  /**
   * @param {string} state
   * @param {string} reasons
   */
  const one = (state, reasons) => ({
    state: state ?? "unknown",
    reasonCodes: reasons ? String(reasons).split(",") : [],
    // No row means nothing was checked; "current" would claim it was.
    basis: c?.basis ?? null,
    observedAt: c?.observedAt ?? null,
  });
  return {
    publicContact: one(c?.publicContact, c?.publicContactReasons),
    siteContact: one(c?.siteContact, c?.siteContactReasons),
  };
}

/** @param {Record<string, any>} site */
function siteDims(site) {
  return {
    siteId: site.siteId,
    name: site.name,
    status: site.status,
    siteType: site.siteType,
    providerId: site.providerId,
    programId: site.programId,
    department: site.department,
    managerId: site.managerId,
    hasLocation: site.hasLocation,
  };
}

// One builder for Overview and its CSV, so the two always agree.
/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {Record<string, any>[]} sites
 */
function siteRows(snap, interval, sites) {
  const ids = new Set(sites.map((s) => s.siteId));
  const today = pacificDateKey(snap.manifest.evaluatedAt);
  const { total, bySite } = sumDays(snap, interval, ids);
  /** @type {Map<string, number>} */
  const maxSeverity = new Map();
  for (const issue of snap.tables.issues) {
    if (!ids.has(issue.siteId)) continue;
    if (
      issue.createdDay < interval.startDay ||
      issue.createdDay >= interval.endDay
    )
      continue;
    if (issue.severity > (maxSeverity.get(issue.siteId) ?? 0))
      maxSeverity.set(issue.siteId, issue.severity);
  }
  const rows = sites.map((site) => {
    const totals = split(bySite.get(site.siteId) ?? {});
    const indicators = contacts(snap, site.siteId);
    return {
      ...siteDims(site),
      ...totals,
      maxSeverity: maxSeverity.get(site.siteId) ?? null,
      ...indicators,
      concerns: concernsOf(totals, indicators, {
        active: site.status !== "inactive",
        expectedChecks: owesChecks(snap, site, interval, today),
      }),
      unknownEvidence: unknownsOf(totals, indicators, {
        active: site.status !== "inactive",
      }),
      manageHref: manageHref(site.siteId),
    };
  });
  return { rows, total, ids };
}

/**
 * @param {string} a
 * @param {string} b day keys
 */
const laterDay = (a, b) => (b > a ? b : a);
/**
 * @param {string} a
 * @param {string} b day keys
 */
const earlierDay = (a, b) => (b < a ? b : a);

/**
 * No perimeter means nothing to walk, and the first day of the records or
 * of the Site is likely partial, so neither can owe Checks.
 * @param {Snapshot} snap
 * @param {Record<string, any>} site
 * @param {Interval} interval
 * @param {string} today Pacific day key, still running
 */
function owesChecks(snap, site, interval, today) {
  if (!site.hasPerimeter || snap.coverageStart === null) return false;
  // A createdAt that doesn't parse can't say when the Site began.
  const added = site.createdAt ? pacificDateKey(site.createdAt) : "";
  const begun = laterDay(snap.coverageStart, added);
  const first = laterDay(interval.startDay, addDays(begun, 1));
  return first < earlierDay(interval.endDay, today);
}

/**
 * Plan §7's Top concerns, plus no Checks, as separate reasons. Awaiting isn't
 * one: there's still time to answer. A closed Site can only be flagged by its
 * Issues.
 * @param {ReturnType<typeof split>} totals
 * @param {ReturnType<typeof contacts>} indicators
 * @param {{ active: boolean, expectedChecks: boolean }} site
 * @returns {string[]}
 */
function concernsOf(
  { activity, response },
  indicators,
  { active, expectedChecks },
) {
  return [
    response.overdue > 0 && "overdue",
    response.late > 0 && "late",
    activity.severeIssues > 0 && "severe",
    active &&
      expectedChecks &&
      activity.completedPerimeterChecks === 0 &&
      "noChecks",
    active && indicators.publicContact.state === "missing" && "publicContact",
    active && indicators.siteContact.state === "missing" && "siteContact",
  ].filter((c) => typeof c === "string");
}

/**
 * Unknown isn't Missing, so it gets its own list. A closed Site's contacts
 * don't matter.
 * @param {ReturnType<typeof split>} totals
 * @param {ReturnType<typeof contacts>} indicators
 * @param {{ active: boolean }} site
 * @returns {string[]}
 */
function unknownsOf({ response }, indicators, { active }) {
  return [
    response.unknown > 0 && "response",
    active && indicators.publicContact.state === "unknown" && "publicContact",
    active && indicators.siteContact.state === "unknown" && "siteContact",
  ].filter((c) => typeof c === "string");
}

// Must cover every key in LIST_FILTERS.sites; a test holds the two together.
/** @type {Record<string, (row: Record<string, any>, value: string) => boolean>} */
export const SITE_ROW_FILTERS = {
  show: (row, value) =>
    value === "all" ||
    (value === "top" ? row.concerns : row.unknownEvidence).length > 0,
  responseState: (row, value) => row.response[value] > 0,
  publicContact: (row, value) => row.publicContact.state === value,
  siteContact: (row, value) => row.siteContact.state === value,
};

/**
 * Overview and its CSV keep the same Sites, with totals over only those.
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {SiteFilter} filter
 * @param {Record<string, string>} filters
 */
function filteredSiteRows(snap, interval, filter, filters) {
  const all = siteRows(snap, interval, matchSites(snap, filter));
  const active = outcomeFilters(filters);
  if (!active.length) return all;
  const rows = all.rows.filter((row) =>
    active.every(([name, value]) => SITE_ROW_FILTERS[name](row, value)),
  );
  const ids = new Set(rows.map((r) => r.siteId));
  return { rows, total: sumDays(snap, interval, ids).total, ids };
}

// The filters that drop rows; All Sites keeps every row, so it isn't one.
/**
 * @param {Record<string, string>} filters
 * @returns {[string, string][]}
 */
function outcomeFilters(filters) {
  return Object.entries(filters).filter(
    ([name, value]) => !(name === "show" && value === "all"),
  );
}

// Must cover every key in SORTS.sites; a test holds the two together.
const SITE_SORT_VALUE = {
  /** @param {any} r */ name: (r) => r.name ?? r.siteId,
  /** @param {any} r */ overdueLate: (r) =>
    r.response.overdue + r.response.late,
  /** @param {any} r */ maxSeverity: (r) => r.maxSeverity,
  /** @param {any} r */
  completedPerimeterChecks: (r) => r.activity.completedPerimeterChecks,
  /** @param {any} r */ issuesCreated: (r) => r.activity.issuesCreated,
};

/**
 * @template {Record<string, any>} T
 * @param {T[]} rows
 * @param {{ key: string, dir: "asc" | "desc" }} sort
 * @returns {T[]}
 */
function sortSiteRows(rows, sort) {
  const value =
    SITE_SORT_VALUE[/** @type {keyof typeof SITE_SORT_VALUE} */ (sort.key)];
  if (!value) throw requestError("invalid_sort");
  const keyed = rows.map((r) => ({
    row: r,
    sortValue: value(r),
    tieName: r.name ?? "",
    tieId: r.siteId,
  }));
  return sortRows(keyed, { key: "sortValue", dir: sort.dir }, [
    "tieName",
    "tieId",
  ]).map((k) => k.row);
}

/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, filter: SiteFilter, list: ListQuery, now: number }} req
 */
export function overview(snap, { interval, filter, list, now }) {
  const { rows, total, ids } = filteredSiteRows(
    snap,
    interval,
    filter,
    list.filters,
  );
  const sorted = sortSiteRows(rows, list.sort);
  const query = {
    kind: "overview",
    period: periodKey(interval),
    filter,
    filters: list.filters,
    sort: list.sort,
    limit: list.limit,
  };
  const { page, nextCursor, offset } = paginate(sorted, list, query, snap);
  return {
    meta: meta(snap, interval, now),
    totals: split(total),
    // Over the same Sites as totals, so its change explains those numbers.
    comparison: comparison(snap, interval, ids),
    siteCount: rows.length,
    // A page reopened from its link numbers its rows from here.
    offset,
    sites: page,
    nextCursor,
  };
}

// Days with no rows are real zeros.
/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @returns {string[]}
 */
function coveredDays(snap, interval) {
  if (snap.coverageStart === null) return [];
  const start = laterDay(interval.startDay, snap.coverageStart);
  const today = addDays(pacificDateKey(snap.manifest.evaluatedAt), 1);
  const end = earlierDay(interval.endDay, today);
  return start < end ? dayKeysBetween(start, end) : [];
}

/**
 * @param {Snapshot} snap
 * @param {string} siteId
 * @returns {Record<string, any>}
 */
function siteOr404(snap, siteId) {
  const site = snap.sitesById.get(siteId);
  if (!site) throw requestError("site_not_found", 404);
  return site;
}

/**
 * @param {Snapshot} snap
 * @param {string} siteId
 * @param {{ interval: Interval, now: number }} req
 */
export function siteDetail(snap, siteId, { interval, now }) {
  const site = siteOr404(snap, siteId);
  const ids = new Set([siteId]);
  /** @type {Map<string, Record<string, any>>} */
  const byDay = new Map();
  for (const row of snap.tables.site_days)
    if (row.siteId === siteId) byDay.set(row.day, row);
  const zero = Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0]));
  return {
    meta: meta(snap, interval, now),
    site: { ...siteDims(site), manageHref: manageHref(siteId) },
    ...contacts(snap, siteId),
    totals: split(sumDays(snap, interval, ids).total),
    comparison: comparison(snap, interval, ids),
    days: coveredDays(snap, interval).map((day) => {
      const row = byDay.get(day) ?? zero;
      return {
        day,
        ...Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, row[m] ?? 0])),
      };
    }),
  };
}

/**
 * @param {Snapshot} snap
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
function withSiteName(snap, row) {
  const site = snap.sitesById.get(row.siteId);
  return { ...row, siteName: site?.name ?? null };
}

/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {SiteFilter} filter
 * @param {Record<string, string>} filters
 */
function issuesIn(snap, interval, filter, filters) {
  const ids = new Set(matchSites(snap, filter).map((s) => s.siteId));
  return snap.tables.issues.filter(
    (i) =>
      ids.has(i.siteId) &&
      i.createdDay >= interval.startDay &&
      i.createdDay < interval.endDay &&
      (!filters.severityBand || i.severityBand === filters.severityBand) &&
      (!filters.responseState || i.responseState === filters.responseState) &&
      (!filters.source || i.source === filters.source) &&
      (!filters.category || i.category === filters.category) &&
      (!filters.issueStatus ||
        (filters.issueStatus === "resolved") === (i.resolvedAt !== null)),
  );
}

/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {SiteFilter} filter
 * @param {Record<string, string>} filters
 */
const matchingIssues = (snap, interval, filter, filters) =>
  issuesIn(snap, interval, filter, filters).map((i) => withSiteName(snap, i));

// Issues by created day, with their responses up to the snapshot.
/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, filter: SiteFilter, list: ListQuery, now: number }} req
 */
export function listIssues(snap, { interval, filter, list, now }) {
  const rows = sortRows(
    matchingIssues(snap, interval, filter, list.filters),
    list.sort,
    ["siteId", "issueId"],
  );
  const query = {
    kind: "issues",
    period: periodKey(interval),
    filter,
    filters: list.filters,
    sort: list.sort,
    limit: list.limit,
  };
  const { page, nextCursor } = paginate(rows, list, query, snap);
  return {
    meta: meta(snap, interval, now),
    total: rows.length,
    issues: page,
    nextCursor,
  };
}

/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {SiteFilter} filter
 * @param {Record<string, string>} filters
 */
function checksIn(snap, interval, filter, filters) {
  const ids = new Set(matchSites(snap, filter).map((s) => s.siteId));
  return snap.tables.checks.filter(
    (c) =>
      ids.has(c.siteId) &&
      c.day >= interval.startDay &&
      c.day < interval.endDay &&
      (!filters.state || c.state === filters.state) &&
      (!filters.source || c.source === filters.source),
  );
}

/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {SiteFilter} filter
 * @param {Record<string, string>} filters
 */
const matchingChecks = (snap, interval, filter, filters) =>
  checksIn(snap, interval, filter, filters).map((c) => withSiteName(snap, c));

// Completed Checks by completion day, unfinished ones by start day.
/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, filter: SiteFilter, list: ListQuery, now: number }} req
 */
export function listChecks(snap, { interval, filter, list, now }) {
  const rows = sortRows(
    matchingChecks(snap, interval, filter, list.filters),
    list.sort,
    ["siteId", "checkId"],
  );
  const query = {
    kind: "checks",
    period: periodKey(interval),
    filter,
    filters: list.filters,
    sort: list.sort,
    limit: list.limit,
  };
  const { page, nextCursor } = paginate(rows, list, query, snap);
  return {
    meta: meta(snap, interval, now),
    total: rows.length,
    checks: page,
    nextCursor,
  };
}

/**
 * @param {Map<string, Record<string, any>[]>} index
 * @param {string} id
 * @param {string | undefined} siteId needed only if two Sites share the ID
 * @param {string} notFound
 */
function findOne(index, id, siteId, notFound) {
  const found = (index.get(id) ?? []).filter(
    (r) => !siteId || r.siteId === siteId,
  );
  if (!found.length) throw requestError(notFound, 404);
  if (found.length > 1) throw requestError("site_id_required");
  return found[0];
}

/**
 * @param {Snapshot} snap
 * @param {string} siteId
 */
const siteRef = (snap, siteId) => ({
  siteId,
  name: snap.sitesById.get(siteId)?.name ?? null,
  manageHref: manageHref(siteId),
});

/**
 * @param {Snapshot} snap
 * @param {string} issueId
 * @param {{ siteId?: string, now?: number }} req
 */
export function issueDetail(snap, issueId, { siteId, now = Date.now() }) {
  const issue = findOne(snap.issuesById, issueId, siteId, "issue_not_found");
  const check = issue.checkId
    ? ((snap.checksById.get(issue.checkId) ?? []).find(
        (c) => c.siteId === issue.siteId,
      ) ?? null)
    : null;
  return {
    meta: meta(snap, null, now),
    issue,
    check,
    site: siteRef(snap, issue.siteId),
  };
}

/**
 * @param {Snapshot} snap
 * @param {string} checkId
 * @param {{ siteId?: string, now?: number }} req
 */
export function checkDetail(snap, checkId, { siteId, now = Date.now() }) {
  const check = findOne(snap.checksById, checkId, siteId, "check_not_found");
  return {
    meta: meta(snap, null, now),
    check,
    issues: snap.tables.issues.filter(
      (i) => i.siteId === check.siteId && i.checkId === checkId,
    ),
    site: siteRef(snap, check.siteId),
  };
}

// No names of people or Providers; the UI gets those from the existing
// directory reads.
/**
 * @param {Snapshot} snap
 * @param {{ now: number }} req
 */
export function scopeOptions(snap, { now }) {
  /** @type {Record<string, { value: string, sites: number }[]>} */
  const groups = {};
  for (const dim of SITE_DIMENSIONS) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const s of snap.tables.sites)
      if (s[dim] !== null && s[dim] !== undefined)
        counts.set(s[dim], (counts.get(s[dim]) ?? 0) + 1);
    groups[dim] = [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([value, sites]) => ({ value, sites }));
  }
  return {
    meta: meta(snap, null, now),
    groups,
    // From the data, so the Category filter offers only names Issues carry.
    categories: snap.categories,
    sites: snap.tables.sites.map(siteDims),
  };
}

/** @typedef {{ siteIds?: string[], groups?: Record<string, string[]> }} TrendScope */

// Picked Sites add to group matches; an empty scope is citywide.
/**
 * @param {Snapshot} snap
 * @param {TrendScope} scope
 * @returns {Record<string, any>[]}
 */
function scopeSites(snap, scope) {
  const picked = new Set(scope.siteIds ?? []);
  const groups = Object.entries(scope.groups ?? {}).filter(([, v]) => v.length);
  if (!picked.size && !groups.length) return snap.tables.sites;
  return snap.tables.sites.filter(
    (s) =>
      picked.has(s.siteId) ||
      (groups.length > 0 &&
        groups.every(([dim, values]) => values.includes(s[dim]))),
  );
}

// From the period's own first day, so current and prior buckets line up.
/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {"week" | "month"} granularity
 * @param {Set<string>} ids
 * @returns {Record<string, any>[]}
 */
function buckets(snap, interval, granularity, ids) {
  const today = pacificDateKey(snap.manifest.evaluatedAt);
  const out = [];
  let start = interval.startDay;
  while (start < interval.endDay && start <= today) {
    const next =
      granularity === "week" ? addDays(start, 7) : addMonthsToFirst(start, 1);
    const end = next < interval.endDay ? next : interval.endDay;
    out.push({
      start,
      end,
      partial: end > today,
      // Before the first record, zero would claim a quiet time, not no data.
      noData: snap.coverageStart === null || end <= snap.coverageStart,
      partialCoverage:
        snap.coverageStart !== null &&
        start < snap.coverageStart &&
        end > snap.coverageStart,
      ...sumDays(snap, { startDay: start, endDay: end }, ids).total,
    });
    start = end;
  }
  return out;
}

/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, scope: TrendScope, breakdown?: string, now: number }} req
 */
export function trends(snap, { interval, scope, breakdown, now }) {
  const sites = scopeSites(snap, scope);
  const ids = new Set(sites.map((s) => s.siteId));
  // Only a year's prior has the same months; a custom one would pair unequal months.
  /** @type {"week" | "month"} */
  const granularity =
    interval.kind === "year" || interval.kind === "financialYear"
      ? "month"
      : "week";
  const prior = previousOf(interval, snap.manifest.evaluatedAt);
  /** @type {Map<string, { issues: number, severeIssues: number }>} */
  const byCategory = new Map();
  for (const i of snap.tables.issues) {
    if (
      !ids.has(i.siteId) ||
      i.createdDay < interval.startDay ||
      i.createdDay >= interval.endDay
    )
      continue;
    const name = i.category ?? "unknown";
    const c = byCategory.get(name) ?? { issues: 0, severeIssues: 0 };
    c.issues += 1;
    if (i.severityBand === "severe") c.severeIssues += 1;
    byCategory.set(name, c);
  }
  // Same days as the top comparison, so the page never shows two answers.
  const cmp = comparisonFor(interval, snap.manifest.evaluatedAt);
  /** @type {Map<string, Record<string, any>[]>} */
  const groups = new Map();
  if (breakdown)
    for (const s of sites) {
      const value = s[breakdown] ?? "unknown";
      const members = groups.get(value);
      if (members) members.push(s);
      else groups.set(value, [s]);
    }
  return {
    meta: meta(snap, interval, now),
    scope: { siteCount: sites.length, siteIds: sites.map((s) => s.siteId) },
    comparison: comparison(snap, interval, ids),
    series: {
      granularity,
      current: buckets(snap, interval, granularity, ids),
      prior: buckets(snap, prior, granularity, ids),
    },
    categories: [...byCategory]
      .sort(([a, x], [b, y]) => y.issues - x.issues || a.localeCompare(b))
      .map(([category, c]) => ({ category, ...c })),
    breakdown: breakdown
      ? [...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([value, members]) => {
            const memberIds = new Set(members.map((m) => m.siteId));
            return {
              value,
              sites: members.length,
              current: sumDays(snap, cmp.current, memberIds).total,
              prior: cmp.prior
                ? sumDays(snap, cmp.prior, memberIds).total
                : null,
            };
          })
      : null,
  };
}

/** CSV columns per dataset, fixed so a spreadsheet built on one keeps working. */
export const EXPORT_COLUMNS = Object.freeze({
  issues: [
    "issueId",
    "siteId",
    "siteName",
    "checkId",
    "source",
    "createdAt",
    "category",
    "severity",
    "severityBand",
    "status",
    "deadlineAt",
    "firstResponseAt",
    "responseBasis",
    "responseState",
    "resolvedAt",
    "reopened",
    "sightings",
    "followUpTasks",
    "latestActivityAt",
  ],
  checks: [
    "checkId",
    "siteId",
    "siteName",
    "source",
    "state",
    "startedAt",
    "completedAt",
    "activityAt",
    "day",
    "issues",
  ],
  sites: [
    "siteId",
    "name",
    "status",
    "siteType",
    "providerId",
    "programId",
    "department",
    "managerId",
    ...ACTIVITY,
    ...RESPONSE_STATES,
    "maxSeverity",
    "publicContact",
    "siteContact",
    "contactBasis",
  ],
});

// Counted without building rows, so refusing a too-large export stays fast.
/**
 * @param {Snapshot} snap
 * @param {{ dataset: "issues" | "checks" | "sites", interval: Interval, filter: SiteFilter, list: ListQuery }} req
 * @returns {number}
 */
export function exportRowCount(snap, { dataset, interval, filter, list }) {
  if (dataset === "issues")
    return issuesIn(snap, interval, filter, list.filters).length;
  if (dataset === "checks")
    return checksIn(snap, interval, filter, list.filters).length;
  // Outcome filters need each Site's totals; without them, counting is enough.
  if (!outcomeFilters(list.filters).length)
    return matchSites(snap, filter).length;
  return filteredSiteRows(snap, interval, filter, list.filters).rows.length;
}

/**
 * @param {Snapshot} snap
 * @param {{ dataset: "issues" | "checks" | "sites", interval: Interval, filter: SiteFilter, list: ListQuery }} req
 * @returns {{ columns: string[], rows: Record<string, any>[] }}
 */
export function exportRows(snap, { dataset, interval, filter, list }) {
  const columns = [...EXPORT_COLUMNS[dataset]];
  if (dataset === "issues")
    return {
      columns,
      rows: sortRows(
        matchingIssues(snap, interval, filter, list.filters),
        list.sort,
        ["siteId", "issueId"],
      ),
    };
  if (dataset === "checks")
    return {
      columns,
      rows: sortRows(
        matchingChecks(snap, interval, filter, list.filters),
        list.sort,
        ["siteId", "checkId"],
      ),
    };
  const { rows } = filteredSiteRows(snap, interval, filter, list.filters);
  return {
    columns,
    rows: sortSiteRows(rows, list.sort).map((r) => ({
      ...r,
      ...r.activity,
      ...r.response,
      publicContact: r.publicContact.state,
      siteContact: r.siteContact.state,
      contactBasis: r.publicContact.basis,
    })),
  };
}

/**
 * @param {Snapshot} snap
 * @param {{ siteIds: string[], interval: Interval, now: number }} req
 */
export function reportDataset(snap, { siteIds, interval, now }) {
  return {
    meta: meta(snap, interval, now),
    sites: siteIds.map((siteId) => {
      const detail = siteDetail(snap, siteId, { interval, now });
      return {
        site: detail.site,
        publicContact: detail.publicContact,
        siteContact: detail.siteContact,
        totals: detail.totals,
        comparison: detail.comparison,
        severeIssues: snap.tables.issues.filter(
          (i) =>
            i.siteId === siteId &&
            i.severityBand === "severe" &&
            i.createdDay >= interval.startDay &&
            i.createdDay < interval.endDay,
        ),
      };
    }),
  };
}
