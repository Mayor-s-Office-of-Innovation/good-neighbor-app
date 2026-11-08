// Counts come as the projection built them, so screens, CSVs and reports can't disagree.

import {
  addDays,
  addMonthsToFirst,
  dayCountBetween,
  dayKeysBetween,
  pacificDateKey,
} from "../../lib/pacific-dates.js";
import { SITE_DAY_METRICS, compareTotals } from "../activity.js";
import { API_VERSION, CONTRACT_VERSION, RESPONSE_STATES } from "../contract.js";
import { comparisonFor, previousOf } from "../periods.js";
import {
  bucketSums,
  categoryCounts,
  checkIssues,
  issueBands,
  owedSums,
  rangeSums,
  recordById,
  recordCount,
  recordList,
  severeIssues,
  siteDays,
  siteFactSums,
} from "./read-sql.js";
import {
  LIST_FILTERS,
  SITE_DIMENSIONS,
  decodeCursor,
  encodeCursor,
  requestError,
} from "./requests.js";

/** @typedef {import("./snapshot.js").Snapshot} Snapshot */
/** @typedef {import("./snapshot.js").Query} Query */
/** @typedef {import("../periods.js").Interval} Interval */
/** @typedef {import("./requests.js").SiteFilter} SiteFilter */
/** @typedef {import("./requests.js").ListQuery} ListQuery */

const STALE_AFTER_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
const NAMES = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const NAME_KEYS = new Set(["name", "siteName", "tieName", "sortValue"]);
const ACTIVITY = SITE_DAY_METRICS.filter((m) => !RESPONSE_STATES.includes(m));
const SEVERITY_BANDS = LIST_FILTERS.issues.severityBand;

// Placeholder concern limits, to be revised. Few Checks needs none: each Site owes its own number.
export const CONCERN_RULES = Object.freeze({
  severeIssues: 2,
  issuesPer30Days: 4,
  unresolvedDays: 14,
});

/**
 * Timed to its resolution as well, so a past period's count doesn't change
 * with the day it's run. Overdue and late are left out: slow response counts
 * them already.
 * @param {Record<string, any>} issue
 * @param {number} evaluatedAtMs
 * @returns {boolean}
 */
export function isLongUnresolved(issue, evaluatedAtMs) {
  if (issue.responseState === "overdue" || issue.responseState === "late")
    return false;
  const end = issue.resolvedAt ? Date.parse(issue.resolvedAt) : evaluatedAtMs;
  return (
    end - Date.parse(issue.createdAt) > CONCERN_RULES.unresolvedDays * DAY_MS
  );
}

/**
 * The Issues behind each concern flag, so a flag's "See" link lists them.
 * @type {Record<string, (issue: Record<string, any>, evaluatedAtMs: number) => boolean>}
 */
const CONCERN_ISSUES = {
  slowResponse: (issue, evaluatedAtMs) =>
    issue.responseState === "overdue" ||
    issue.responseState === "late" ||
    isLongUnresolved(issue, evaluatedAtMs),
  repeatedSevere: (issue) => issue.severityBand === "severe",
};

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
  return snap.sites.filter(
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
 * Every Site's ID, or null when they're all asked for, so the query reads the
 * Sites from the snapshot rather than bind a list of them.
 * @param {Snapshot} snap
 * @param {Record<string, any>[]} sites
 * @returns {string[] | null}
 */
const idsOf = (snap, sites) =>
  sites.length === snap.sites.length ? null : sites.map((s) => s.siteId);

/** @returns {Record<string, number>} */
const zeroTotals = () =>
  Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0]));

/**
 * @param {Record<string, any> | undefined} row
 * @param {string} prefix
 * @returns {Record<string, number>}
 */
const totalsFrom = (row, prefix = "") =>
  Object.fromEntries(
    SITE_DAY_METRICS.map((m) => [m, row?.[`${prefix}${m}`] ?? 0]),
  );

// One read for every range, so a comparison costs one query.
/**
 * @param {Query} q
 * @param {{ startDay: string, endDay: string }[]} ranges
 * @param {string[] | null} ids
 * @returns {Promise<Record<string, number>[]>}
 */
async function rangeTotals(q, ranges, ids) {
  const st = rangeSums(ranges, ids, false);
  const [row] = await q(st.sql, st.params);
  return ranges.map((_, k) => totalsFrom(row, `r${k}_`));
}

/**
 * @param {Query} q
 * @param {{ startDay: string, endDay: string }[]} ranges
 * @param {string[] | null} ids
 * @returns {Promise<Map<string, Record<string, number>[]>>}
 */
async function rangeTotalsBySite(q, ranges, ids) {
  const st = rangeSums(ranges, ids, true);
  return new Map(
    (await q(st.sql, st.params)).map((row) => [
      row.siteId,
      ranges.map((_, k) => totalsFrom(row, `r${k}_`)),
    ]),
  );
}

/**
 * @param {Snapshot} snap
 * @param {ReturnType<typeof comparisonFor>} cmp
 * @param {Record<string, number>[] | null} totals current, then prior
 */
function comparisonFrom(snap, cmp, totals) {
  // A running period's totals count today, which the comparison can't split, so say so.
  const sameDaysAsTotals = cmp.basis === "complete_period";
  if (!cmp.prior)
    return { ...cmp, sameDaysAsTotals, priorCoverage: null, change: null };
  const [current, prior] = totals ?? [zeroTotals(), zeroTotals()];
  return {
    ...cmp,
    sameDaysAsTotals,
    priorCoverage: priorCoverage(snap, cmp.prior),
    change: compareTotals(current, prior),
  };
}

/**
 * @param {Query} q
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {string[] | null} ids
 */
async function comparison(q, snap, interval, ids) {
  const cmp = comparisonFor(interval, snap.manifest.evaluatedAt);
  if (!cmp.prior) return comparisonFrom(snap, cmp, null);
  return comparisonFrom(
    snap,
    cmp,
    await rangeTotals(q, [cmp.current, cmp.prior], ids),
  );
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
// Exported for the admin E2E fake, so its lists come out in the same order.
/**
 * @template {Record<string, any>} T
 * @param {T[]} rows
 * @param {{ key: string, dir: "asc" | "desc" }} sort
 * @param {string[]} ties
 * @returns {T[]}
 */
export function sortRows(rows, sort, ties) {
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
 * Each Site's place in name order, as sortRows orders names, for SQL to sort
 * by; same names share a place. A Site with no name has none.
 * @param {Record<string, any>[]} sites
 * @returns {Map<string, number>}
 */
export function siteNameRanks(sites) {
  const names = [
    ...new Set(sites.map((s) => s.name).filter((n) => n != null)),
  ].sort((a, b) => compareValues({ siteName: a }, { siteName: b }, "siteName"));
  const rank = new Map(names.map((name, i) => [name, i]));
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const s of sites)
    if (s.name != null)
      out.set(s.siteId, /** @type {number} */ (rank.get(s.name)));
  return out;
}

/**
 * @param {ListQuery} list
 * @param {unknown} query everything that shaped the list, for the cursor
 * @param {Snapshot} snap
 * @returns {number}
 */
const offsetOf = (list, query, snap) =>
  list.cursor ? decodeCursor(list.cursor, query, snap.snapshotId) : 0;

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

// Only the contact posted for neighbors; the Site manager's is private.
/**
 * @param {Snapshot} snap
 * @param {string} siteId
 * @returns {{ email: string | null, phone: string | null, phoneExtension: string | null }}
 */
function publicContactDetails(snap, siteId) {
  const record = snap.contactsBySite.get(siteId);
  return {
    email: record?.publicEmail ?? null,
    phone: record?.publicPhone ?? null,
    phoneExtension: record?.publicPhoneExtension ?? null,
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
 * @param {Query} q
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {Record<string, any>[]} sites
 */
async function siteRows(q, snap, interval, sites) {
  const all = await siteFactsMany(q, snap, sites, interval);
  const rows = sites.map((site) => {
    const facts = /** @type {SiteFacts} */ (all.get(site.siteId));
    const indicators = contacts(snap, site.siteId);
    return {
      ...siteDims(site),
      ...facts.totals,
      maxSeverity: facts.maxSeverity,
      checksPerDay: facts.checksPerDay,
      checksOwedPerDay: facts.checksOwedPerDay,
      checksPerOwedDay: facts.checksPerOwedDay,
      issuesPer30Days: facts.issuesPer30Days,
      longUnresolved: facts.longUnresolved,
      ...indicators,
      concerns: facts.concerns,
      unknownEvidence: unknownsOf(facts.totals, indicators, {
        active: site.status !== "inactive",
        hasTerms: site.hasTerms,
      }),
      manageHref: manageHref(site.siteId),
    };
  });
  return rows;
}

// From the rows already summed, so Overview reads each Site's days once.
/**
 * @param {{ activity: Record<string, number>, response: Record<string, number> }[]} rows
 * @returns {Record<string, number>}
 */
function totalOf(rows) {
  const total = Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0]));
  for (const row of rows) {
    for (const m of ACTIVITY) total[m] += row.activity[m];
    for (const m of RESPONSE_STATES) total[m] += row.response[m];
  }
  return total;
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
 * The period's whole days with records for this Site. Today is still
 * running, and the first day of the records or of the Site is likely
 * partial, so none of them count.
 * @param {Snapshot} snap
 * @param {Record<string, any>} site
 * @param {Interval} interval
 * @param {string} today Pacific day key
 * @returns {{ startDay: string, endDay: string } | null}
 */
function wholeDays(snap, site, interval, today) {
  const first = firstWholeDay(snap, site, interval);
  if (first === null) return null;
  const end = earlierDay(interval.endDay, today);
  return first < end ? { startDay: first, endDay: end } : null;
}

/**
 * @param {Snapshot} snap
 * @param {Record<string, any>} site
 * @param {Interval} interval
 * @returns {string | null}
 */
function firstWholeDay(snap, site, interval) {
  if (snap.coverageStart === null) return null;
  const begun = laterDay(snap.coverageStart, addedDay(site));
  return laterDay(interval.startDay, addDays(begun, 1));
}

/**
 * The days a Site's Issues per 30 days spreads them over: from the Checks
 * average's first day to the update. Today counts, since its Issues do.
 * @param {Snapshot} snap
 * @param {Record<string, any>} site
 * @param {Interval} interval
 * @param {string} today Pacific day key
 * @returns {{ startDay: string, endDay: string } | null}
 */
function issueSpanOf(snap, site, interval, today) {
  const first = firstWholeDay(snap, site, interval);
  if (first === null) return null;
  const end = earlierDay(interval.endDay, addDays(today, 1));
  return first < end ? { startDay: first, endDay: end } : null;
}

/**
 * @param {Record<string, any>} site
 * @returns {string}
 */
function addedDay(site) {
  // A createdAt that doesn't parse can't say when the Site began.
  return site.createdAt ? pacificDateKey(site.createdAt) : "";
}

/** @param {number} n */
const oneDecimal = (n) => Math.round(n * 10) / 10;

/** @typedef {Awaited<ReturnType<typeof siteFactsMany>> extends Map<string, infer F> ? F : never} SiteFacts */

/**
 * One reading of each Site's period, so its Overview row, Site page and report
 * show the same numbers and flags. Read for every Site at once, since a query
 * per Site would make thousands for a citywide report.
 * @param {Query} q
 * @param {Snapshot} snap
 * @param {Record<string, any>[]} sites
 * @param {Interval} interval
 */
async function siteFactsMany(q, snap, sites, interval) {
  // A repeated Site would join its window twice and double its sums.
  sites = [...new Map(sites.map((s) => [s.siteId, s])).values()];
  const today = pacificDateKey(snap.manifest.evaluatedAt);
  const ranges = sites.map((site) => wholeDays(snap, site, interval, today));
  const spans = sites.map((site) => issueSpanOf(snap, site, interval, today));
  // Rows from before the Site was added aren't the Site's activity.
  const from = sites.map((site) => laterDay(interval.startDay, addedDay(site)));
  const ids = sites.map((s) => s.siteId);
  /** @type {Map<string, Record<string, any>>} */
  const sums = new Map();
  /** @type {Map<string, Record<string, any>>} */
  const owedBySite = new Map();
  /** @type {Map<string, Record<string, any>[]>} */
  const bandsBySite = new Map();
  if (ids.length) {
    const period = siteFactSums(
      ids,
      from,
      ranges.map((r) => r?.startDay ?? null),
      ranges.map((r) => r?.endDay ?? null),
      spans.map((r) => r?.startDay ?? null),
      interval,
    );
    for (const row of await q(period.sql, period.params))
      sums.set(row.siteId, row);
    // No perimeter means nothing owed, so no target.
    const walked = sites.flatMap((site, k) =>
      site.hasPerimeter && ranges[k] ? [{ site, range: ranges[k] }] : [],
    );
    if (walked.length) {
      const owed = owedSums(
        walked.map((w) => w.site.siteId),
        walked.map((w) => w.range.startDay),
        walked.map((w) => w.range.endDay),
      );
      for (const row of await q(owed.sql, owed.params))
        owedBySite.set(row.siteId, row);
    }
    const bands = issueBands(ids, from, interval);
    for (const row of await q(bands.sql, bands.params)) {
      const list = bandsBySite.get(row.siteId);
      if (list) list.push(row);
      else bandsBySite.set(row.siteId, [row]);
    }
  }
  return new Map(
    sites.map((site, k) => {
      const range = ranges[k];
      const days = range
        ? dayKeysBetween(range.startDay, range.endDay).length
        : 0;
      const row = sums.get(site.siteId);
      const totals = split(totalsFrom(row));
      const checks = row?.wholeDayChecks ?? 0;
      const owed =
        site.hasPerimeter && range
          ? (owedBySite.get(site.siteId) ?? { days: 0, owed: 0, completed: 0 })
          : null;
      /** @type {number | null} */
      let maxSeverity = null;
      let longUnresolved = 0;
      /** @type {Record<string, number>} */
      const severity = Object.fromEntries(SEVERITY_BANDS.map((b) => [b, 0]));
      for (const band of bandsBySite.get(site.siteId) ?? []) {
        severity[band.severityBand] += band.n;
        if (band.maxSeverity > (maxSeverity ?? 0))
          maxSeverity = band.maxSeverity;
        longUnresolved += band.longUnresolved;
      }
      const checksOwedPerDay = owed?.days
        ? oneDecimal(owed.owed / owed.days)
        : null;
      // Few Checks shows this one, since days the Site owed nothing don't count.
      const checksPerOwedDay = owed?.days
        ? oneDecimal(owed.completed / owed.days)
        : null;
      // The pages show one average, the one Few Checks judges, when there is one.
      // Sites with no perimeter on file still log Checks, so they get a plain one.
      const checksPerDay =
        checksPerOwedDay ?? (days ? oneDecimal(checks / days) : null);
      // Rounded first, so "3.0 a day" is never under its own number of 3.
      const underOwed =
        checksPerOwedDay !== null &&
        checksOwedPerDay !== null &&
        checksPerOwedDay < checksOwedPerDay;
      const span = spans[k];
      const issueDays = span ? dayCountBetween(span.startDay, span.endDay) : 0;
      // Short periods count as 30 days, so a quiet week isn't flagged for 2 Issues.
      const issuesPer30Days = issueDays
        ? oneDecimal(((row?.spanIssues ?? 0) * 30) / Math.max(issueDays, 30))
        : null;
      const facts = {
        totals,
        severity,
        maxSeverity,
        checksPerDay,
        checksOwedPerDay,
        checksPerOwedDay,
        issuesPer30Days,
        longUnresolved,
      };
      const concerns = concernsOf(
        { ...facts, underOwed },
        site.status !== "inactive",
      );
      return [site.siteId, { ...facts, concerns }];
    }),
  );
}

/**
 * In the order the pages list them. Awaiting isn't one: there's still time
 * to answer. A closed Site can't be flagged for few Checks. A missing
 * contact shows on the Site page but isn't a concern, since it isn't
 * activity in the period.
 * @param {{ totals: ReturnType<typeof split>, underOwed: boolean, longUnresolved: number, issuesPer30Days: number | null }} facts
 * @param {boolean} active
 * @returns {string[]}
 */
export function concernsOf(
  {
    totals: { activity, response },
    underOwed,
    longUnresolved,
    issuesPer30Days,
  },
  active,
) {
  const rules = CONCERN_RULES;
  return [
    active && underOwed && "fewChecks",
    activity.severeIssues >= rules.severeIssues && "repeatedSevere",
    // The rounded rate, so the flag agrees with the number on screen.
    issuesPer30Days !== null &&
      issuesPer30Days > rules.issuesPer30Days &&
      "manyIssues",
    // One flag for all three, since managers read them as one problem.
    (longUnresolved > 0 || response.overdue > 0 || response.late > 0) &&
      "slowResponse",
  ].filter((c) => typeof c === "string");
}

/**
 * Unknown isn't Missing, so it gets its own list. A closed Site's contacts
 * don't matter.
 * @param {ReturnType<typeof split>} totals
 * @param {ReturnType<typeof contacts>} indicators
 * @param {{ active: boolean, hasTerms?: boolean | null }} site
 * @returns {string[]}
 */
function unknownsOf({ response }, indicators, { active, hasTerms }) {
  return [
    response.unknown > 0 && "response",
    active && indicators.publicContact.state === "unknown" && "publicContact",
    active && indicators.siteContact.state === "unknown" && "siteContact",
    // With no terms it owes no Checks, so Few Checks can't flag it.
    active && hasTerms === false && "terms",
  ].filter((c) => typeof c === "string");
}

// Must cover every key in LIST_FILTERS.sites; a test holds the two together.
/** @type {Record<string, (row: Record<string, any>, value: string) => boolean>} */
export const SITE_ROW_FILTERS = {
  show: (row, value) =>
    value === "all" ||
    (value === "top" ? row.concerns : row.unknownEvidence).length > 0,
  responseState: (row, value) =>
    value.split(",").some((state) => row.response[state] > 0),
  publicContact: (row, value) => row.publicContact.state === value,
  siteContact: (row, value) => row.siteContact.state === value,
};

/**
 * Overview and its CSV keep the same Sites, with totals over only those.
 * @param {Query} q
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {SiteFilter} filter
 * @param {Record<string, string>} filters
 */
async function filteredSiteRows(q, snap, interval, filter, filters) {
  const active = outcomeFilters(filters);
  const rows = (
    await siteRows(q, snap, interval, matchSites(snap, filter))
  ).filter((row) =>
    active.every(([name, value]) => SITE_ROW_FILTERS[name](row, value)),
  );
  return { rows, ids: idsOf(snap, rows) };
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
  // Each column sorts by the number it shows, so none ranks by a hidden total.
  /** @param {any} r */ overdueLate: (r) =>
    r.response.overdue + r.response.late,
  /** @param {any} r */ maxSeverity: (r) => r.maxSeverity,
  /** @param {any} r */ checksPerDay: (r) => r.checksPerDay,
  /** @param {any} r */ issuesPer30Days: (r) => r.issuesPer30Days,
};

/**
 * @template {Record<string, any>} T
 * @param {T[]} rows
 * @param {{ key: string, dir: "asc" | "desc" }} sort
 * @returns {T[]}
 */
export function sortSiteRows(rows, sort) {
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
  return snap.hold(async (q) => {
    const { rows, ids } = await filteredSiteRows(
      q,
      snap,
      interval,
      filter,
      list.filters,
    );
    return {
      meta: meta(snap, interval, now),
      totals: split(totalOf(rows)),
      // Over the same Sites as totals, so its change explains those numbers.
      comparison: await comparison(q, snap, interval, ids),
      siteCount: rows.length,
      // Every Site, so a manager can pick any of them for one report.
      sites: sortSiteRows(rows, list.sort),
    };
  });
}

// Days with no rows are real zeros; days before the Site was added aren't.
/**
 * @param {Snapshot} snap
 * @param {Interval} interval
 * @param {Record<string, any>} site
 * @returns {string[]}
 */
function coveredDays(snap, interval, site) {
  if (snap.coverageStart === null) return [];
  const start = laterDay(
    interval.startDay,
    laterDay(snap.coverageStart, addedDay(site)),
  );
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
 * A Site's page without the day rows; reports skip them, since a year of
 * days for every Site is about 365 objects each.
 * @param {Snapshot} snap
 * @param {Record<string, any>} site
 * @param {SiteFacts} facts
 * @param {ReturnType<typeof comparisonFrom>} comparison
 * @param {{ interval: Interval, now: number }} req
 */
function siteSummary(snap, site, facts, comparison, { interval, now }) {
  const siteId = site.siteId;
  const indicators = contacts(snap, siteId);
  return {
    meta: meta(snap, interval, now),
    site: { ...siteDims(site), manageHref: manageHref(siteId) },
    ...indicators,
    publicContact: {
      ...indicators.publicContact,
      ...publicContactDetails(snap, siteId),
    },
    // Only the Site page has Severe Issues tiles, so Overview rows skip these counts.
    totals: { ...facts.totals, severity: facts.severity },
    checksPerDay: facts.checksPerDay,
    checksOwedPerDay: facts.checksOwedPerDay,
    checksPerOwedDay: facts.checksPerOwedDay,
    issuesPer30Days: facts.issuesPer30Days,
    longUnresolved: facts.longUnresolved,
    concerns: facts.concerns,
    comparison,
  };
}

/**
 * @param {Snapshot} snap
 * @param {string} siteId
 * @param {{ interval: Interval, now: number }} req
 */
export function siteDetail(snap, siteId, { interval, now }) {
  return snap.hold(async (q) => {
    const site = siteOr404(snap, siteId);
    const facts = /** @type {SiteFacts} */ (
      (await siteFactsMany(q, snap, [site], interval)).get(siteId)
    );
    const summary = siteSummary(
      snap,
      site,
      facts,
      await comparison(q, snap, interval, [siteId]),
      { interval, now },
    );
    const st = siteDays(siteId, interval);
    const byDay = new Map(
      (await q(st.sql, st.params)).map((row) => [row.day, row]),
    );
    const zero = zeroTotals();
    return {
      ...summary,
      days: coveredDays(snap, interval, site).map((day) => {
        const row = byDay.get(day) ?? zero;
        return {
          day,
          ...Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, row[m] ?? 0])),
        };
      }),
    };
  });
}

/**
 * The Issues list filters, shared with the admin E2E fake so the two agree.
 * read-sql.js filters the same way; a test holds the two to the same rows.
 * @param {Record<string, any>} i
 * @param {Record<string, string>} filters
 * @param {number} evaluatedAtMs
 * @returns {boolean}
 */
export function issueMatches(i, filters, evaluatedAtMs) {
  return (
    (!filters.severityBand ||
      filters.severityBand.split(",").includes(i.severityBand)) &&
    (!filters.responseState ||
      filters.responseState.split(",").includes(i.responseState)) &&
    (!filters.source || i.source === filters.source) &&
    (!filters.category || i.category === filters.category) &&
    (!filters.issueStatus ||
      (filters.issueStatus === "resolved") === isResolved(i)) &&
    (!filters.concern || CONCERN_ISSUES[filters.concern](i, evaluatedAtMs))
  );
}

/**
 * One page of Issues or Checks, with a fixed tie-break so every page
 * boundary stays put.
 * @param {Query} q
 * @param {Snapshot} snap
 * @param {"issues" | "checks"} kind
 * @param {{ interval: Interval, filter: SiteFilter, list: ListQuery }} req
 */
async function recordPage(q, snap, kind, { interval, filter, list }) {
  const query = {
    kind,
    period: periodKey(interval),
    filter,
    filters: list.filters,
    sort: list.sort,
    limit: list.limit,
  };
  const offset = offsetOf(list, query, snap);
  const ids = idsOf(snap, matchSites(snap, filter));
  const count = recordCount(kind, ids, interval, list.filters);
  const [{ n: total }] = await q(count.sql, count.params);
  const st = recordList(kind, {
    ids,
    period: interval,
    filters: list.filters,
    sort: list.sort,
    page: { limit: list.limit, offset },
  });
  const page = await q(st.sql, st.params);
  const next = offset + list.limit;
  return {
    total,
    page,
    nextCursor:
      next < total ? encodeCursor(query, snap.snapshotId, next) : null,
  };
}

// Issues by created day, with their responses up to the snapshot.
/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, filter: SiteFilter, list: ListQuery, now: number }} req
 */
export function listIssues(snap, { interval, filter, list, now }) {
  return snap.hold(async (q) => {
    const { total, page, nextCursor } = await recordPage(q, snap, "issues", {
      interval,
      filter,
      list,
    });
    return { meta: meta(snap, interval, now), total, issues: page, nextCursor };
  });
}

// Completed Checks by completion day, unfinished ones by start day.
/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, filter: SiteFilter, list: ListQuery, now: number }} req
 */
export function listChecks(snap, { interval, filter, list, now }) {
  return snap.hold(async (q) => {
    const { total, page, nextCursor } = await recordPage(q, snap, "checks", {
      interval,
      filter,
      list,
    });
    return { meta: meta(snap, interval, now), total, checks: page, nextCursor };
  });
}

/**
 * @param {Query} q
 * @param {"issues" | "checks"} kind
 * @param {string} id
 * @param {string | undefined} siteId needed only if two Sites share the ID
 * @param {string} notFound
 */
async function findOne(q, kind, id, siteId, notFound) {
  const st = recordById(kind, id, siteId);
  const found = await q(st.sql, st.params);
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
  return snap.hold(async (q) => {
    const issue = await findOne(
      q,
      "issues",
      issueId,
      siteId,
      "issue_not_found",
    );
    /** @type {Record<string, any> | null} */
    let check = null;
    if (issue.checkId) {
      const st = recordById("checks", issue.checkId, issue.siteId);
      check = (await q(st.sql, st.params))[0] ?? null;
    }
    return {
      meta: meta(snap, null, now),
      issue,
      check,
      site: siteRef(snap, issue.siteId),
    };
  });
}

/**
 * @param {Snapshot} snap
 * @param {string} checkId
 * @param {{ siteId?: string, now?: number }} req
 */
export function checkDetail(snap, checkId, { siteId, now = Date.now() }) {
  return snap.hold(async (q) => {
    const check = await findOne(
      q,
      "checks",
      checkId,
      siteId,
      "check_not_found",
    );
    const st = checkIssues(check.siteId, checkId);
    return {
      meta: meta(snap, null, now),
      check,
      issues: await q(st.sql, st.params),
      site: siteRef(snap, check.siteId),
    };
  });
}

// No names of people or Providers; the UI gets those from the existing
// directory reads.
/**
 * @param {Snapshot} snap
 * @param {{ now: number, include?: string }} req `include: "sites"` adds each Site's ID and name
 */
export async function scopeOptions(snap, { now, include }) {
  /** @type {Record<string, { value: string, sites: number }[]>} */
  const groups = {};
  for (const dim of SITE_DIMENSIONS) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const s of snap.sites)
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
    // Only for a screen that picks Sites by name; Overview's filters don't need it.
    ...(include === "sites" && {
      sites: snap.sites.map((s) => ({ siteId: s.siteId, name: s.name })),
    }),
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
  if (!picked.size && !groups.length) return snap.sites;
  return snap.sites.filter(
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
 * @returns {{ start: string, end: string, partial: boolean, noData: boolean, partialCoverage: boolean }[]}
 */
function bucketEdges(snap, interval, granularity) {
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
    });
    start = end;
  }
  return out;
}

/**
 * Both series' buckets in one read.
 * @param {Query} q
 * @param {ReturnType<typeof bucketEdges>[]} series
 * @param {string[] | null} ids
 * @returns {Promise<Record<string, any>[][]>}
 */
async function buckets(q, series, ids) {
  const edges = series.flat();
  /** @type {Map<number, Record<string, any>>} */
  const sums = new Map();
  if (edges.length) {
    const st = bucketSums(edges, ids);
    for (const row of await q(st.sql, st.params)) sums.set(row.k, row);
  }
  let k = 0;
  return series.map((list) =>
    list.map((edge) => ({ ...edge, ...totalsFrom(sums.get(k++)) })),
  );
}

/**
 * @param {Snapshot} snap
 * @param {{ interval: Interval, scope: TrendScope, breakdown?: string, now: number }} req
 */
export function trends(snap, { interval, scope, breakdown, now }) {
  return snap.hold(async (q) => {
    const sites = scopeSites(snap, scope);
    const ids = idsOf(snap, sites);
    // Only a year's prior has the same months; a custom one would pair unequal months.
    /** @type {"week" | "month"} */
    const granularity =
      interval.kind === "year" || interval.kind === "financialYear"
        ? "month"
        : "week";
    const prior = previousOf(interval, snap.manifest.evaluatedAt);
    const counts = categoryCounts(ids, interval);
    const byCategory = await q(counts.sql, counts.params);
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
    const ranges = cmp.prior ? [cmp.current, cmp.prior] : [cmp.current];
    const bySite = breakdown
      ? await rangeTotalsBySite(q, ranges, ids)
      : new Map();
    /**
     * @param {Record<string, any>[]} members
     * @param {number} k
     */
    const groupTotal = (members, k) => {
      const total = zeroTotals();
      for (const m of members)
        for (const [metric, n] of Object.entries(
          bySite.get(m.siteId)?.[k] ?? {},
        ))
          total[metric] += n;
      return total;
    };
    const [current, priorSeries] = await buckets(
      q,
      [
        bucketEdges(snap, interval, granularity),
        bucketEdges(snap, prior, granularity),
      ],
      ids,
    );
    return {
      meta: meta(snap, interval, now),
      scope: { siteCount: sites.length, siteIds: sites.map((s) => s.siteId) },
      comparison: await comparison(q, snap, interval, ids),
      series: { granularity, current, prior: priorSeries },
      categories: byCategory
        .sort(
          (x, y) => y.issues - x.issues || x.category.localeCompare(y.category),
        )
        .map(({ category, issues, severeIssues }) => ({
          category,
          issues,
          severeIssues,
        })),
      breakdown: breakdown
        ? [...groups]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, members]) => ({
              value,
              sites: members.length,
              current: groupTotal(members, 0),
              prior: cmp.prior ? groupTotal(members, 1) : null,
            }))
        : null,
    };
  });
}

// The words the Insights pages show, so the CSV and the screen agree.
const RESPONSE_WORDS = {
  awaiting: "Awaiting response",
  overdue: "Overdue",
  onTime: "Responded on time",
  late: "Responded late",
  unknown: "Unknown",
  notTimed: "No response time",
};

/** @typedef {[string, (row: Record<string, any>) => unknown][]} CsvFormat */

/**
 * One test for the filter and the CSV, so a file filtered to Resolved never says Open.
 * @param {Record<string, unknown>} issue
 * @returns {boolean}
 */
const isResolved = (issue) => issue.resolvedAt !== null;

/**
 * Raw data's CSV: plain headers, in the order the list shows them. No device
 * columns until Checks record one, and no rule or contract version.
 * Site ID is kept, since record IDs are unique only within a Site.
 * @type {{ issues: CsvFormat, checks: CsvFormat }}
 */
const RECORD_CSV = {
  issues: [
    ["Issue ID", (i) => i.issueId],
    ["Site", (i) => i.siteName ?? i.siteId],
    ["Site ID", (i) => i.siteId],
    ["Category", (i) => i.category],
    ["Severity (1-5)", (i) => i.severity],
    ["State", (i) => (isResolved(i) ? "Resolved" : "Open")],
    ["Created", (i) => i.createdAt],
    ["Response deadline", (i) => i.deadlineAt],
    ["First response", (i) => i.firstResponseAt],
    [
      "Response state",
      (i) =>
        RESPONSE_WORDS[
          /** @type {keyof typeof RESPONSE_WORDS} */ (i.responseState)
        ] ?? "Unknown",
    ],
    ["Resolved", (i) => i.resolvedAt],
    ["Parent check", (i) => i.checkId],
  ],
  checks: [
    ["Check ID", (c) => c.checkId],
    ["Site", (c) => c.siteName ?? c.siteId],
    ["Site ID", (c) => c.siteId],
    [
      "Recorded state",
      (c) => (c.state === "completed" ? "Completed" : "Unfinished"),
    ],
    // The time the list dates the Check by, which a completed Check has even without a finish time.
    ["Completed or started", (c) => c.activityAt],
    ["Issue IDs", (c) => c.issueIds.join(" ")],
  ],
};

// The columns RECORD_CSV reads, besides siteName and issueIds; the export
// selects only these, so its rows take half the memory.
const RECORD_CSV_SOURCE = {
  issues: [
    "issueId",
    "siteId",
    "checkId",
    "createdAt",
    "category",
    "severity",
    "deadlineAt",
    "firstResponseAt",
    "responseState",
    "resolvedAt",
  ],
  checks: ["checkId", "siteId", "state", "activityAt"],
};

/** CSV columns per dataset, fixed so a spreadsheet built on one keeps working. */
export const EXPORT_COLUMNS = Object.freeze({
  issues: RECORD_CSV.issues.map(([header]) => header),
  checks: RECORD_CSV.checks.map(([header]) => header),
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
    "publicEmail",
    "publicPhone",
    "publicPhoneExtension",
    "siteContact",
    "contactBasis",
  ],
});

// Counted without building rows, so refusing a too-large export stays fast.
/**
 * @param {Snapshot} snap
 * @param {{ dataset: "issues" | "checks" | "sites", interval: Interval, filter: SiteFilter, list: ListQuery }} req
 * @returns {Promise<number>}
 */
export function exportRowCount(snap, { dataset, interval, filter, list }) {
  return snap.hold(async (q) => {
    if (dataset !== "sites") {
      const st = recordCount(
        dataset,
        idsOf(snap, matchSites(snap, filter)),
        interval,
        list.filters,
      );
      return (await q(st.sql, st.params))[0].n;
    }
    // Outcome filters need each Site's totals; without them, counting is enough.
    if (!outcomeFilters(list.filters).length)
      return matchSites(snap, filter).length;
    return (await filteredSiteRows(q, snap, interval, filter, list.filters))
      .rows.length;
  });
}

/**
 * @param {Snapshot} snap
 * @param {{ dataset: "issues" | "checks" | "sites", interval: Interval, filter: SiteFilter, list: ListQuery }} req
 * @returns {Promise<{ columns: string[], rows: Record<string, any>[] }>}
 */
export function exportRows(snap, { dataset, interval, filter, list }) {
  const columns = [...EXPORT_COLUMNS[dataset]];
  /**
   * @param {CsvFormat} format
   * @param {Record<string, any>[]} rows
   * @returns {Record<string, unknown>[]}
   */
  const written = (format, rows) =>
    rows.map((row) =>
      Object.fromEntries(format.map(([header, value]) => [header, value(row)])),
    );
  return snap.hold(async (q) => {
    if (dataset !== "sites") {
      const st = recordList(dataset, {
        ids: idsOf(snap, matchSites(snap, filter)),
        period: interval,
        filters: list.filters,
        sort: list.sort,
        issueIds: dataset === "checks",
        only: RECORD_CSV_SOURCE[dataset],
      });
      /** @type {Record<string, unknown>[]} */
      const rows = [];
      await /** @type {NonNullable<Query["each"]>} */ (q.each)(
        st.sql,
        st.params,
        (chunk) => {
          for (const row of written(RECORD_CSV[dataset], chunk)) rows.push(row);
        },
      );
      return { columns, rows };
    }
    const { rows } = await filteredSiteRows(
      q,
      snap,
      interval,
      filter,
      list.filters,
    );
    return {
      columns,
      rows: sortSiteRows(rows, list.sort).map((r) => {
        const posted = publicContactDetails(snap, r.siteId);
        return {
          ...r,
          ...r.activity,
          ...r.response,
          publicContact: r.publicContact.state,
          publicEmail: posted.email,
          publicPhone: posted.phone,
          publicPhoneExtension: posted.phoneExtension,
          siteContact: r.siteContact.state,
          contactBasis: r.publicContact.basis,
        };
      }),
    };
  });
}

/**
 * Every picked Site's summary, read for all of them at once.
 * @param {Snapshot} snap
 * @param {{ siteIds: string[], interval: Interval, now: number }} req
 */
export function reportDataset(snap, { siteIds: asked, interval, now }) {
  return snap.hold(async (q) => {
    // The API already drops repeats; a direct caller's would list a Site twice.
    const siteIds = [...new Set(asked)];
    const sites = siteIds.map((siteId) => siteOr404(snap, siteId));
    const facts = await siteFactsMany(q, snap, sites, interval);
    const cmp = comparisonFor(interval, snap.manifest.evaluatedAt);
    const bySite = cmp.prior
      ? await rangeTotalsBySite(q, [cmp.current, cmp.prior], siteIds)
      : null;
    /** @type {Map<string, Record<string, any>[]>} */
    const severe = new Map();
    if (siteIds.length) {
      const st = severeIssues(siteIds, interval);
      for (const issue of await q(st.sql, st.params)) {
        const list = severe.get(issue.siteId);
        if (list) list.push(issue);
        else severe.set(issue.siteId, [issue]);
      }
    }
    return {
      meta: meta(snap, interval, now),
      sites: sites.map((site) => {
        const detail = siteSummary(
          snap,
          site,
          /** @type {SiteFacts} */ (facts.get(site.siteId)),
          comparisonFrom(snap, cmp, bySite?.get(site.siteId) ?? null),
          { interval, now },
        );
        return {
          site: detail.site,
          publicContact: detail.publicContact,
          // As the Overview row flags it; a closed Site needs none.
          noPublicContact:
            detail.site.status !== "inactive" &&
            detail.publicContact.state === "missing",
          siteContact: detail.siteContact,
          totals: detail.totals,
          checksPerDay: detail.checksPerDay,
          checksOwedPerDay: detail.checksOwedPerDay,
          checksPerOwedDay: detail.checksPerOwedDay,
          issuesPer30Days: detail.issuesPer30Days,
          longUnresolved: detail.longUnresolved,
          concerns: detail.concerns,
          comparison: detail.comparison,
          severeIssues: severe.get(site.siteId) ?? [],
        };
      }),
    };
  });
}
