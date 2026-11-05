// The one Site-day table every Insights page reads, so they never recount.
// Checks count as activity only; nothing here knows how many were expected.

import { pacificDateKey } from "../lib/pacific-dates.js";
import { RESPONSE_STATES } from "./contract.js";

export const SITE_DAY_METRICS = Object.freeze([
  "completedPerimeterChecks",
  "singleIssueReports",
  "unfinishedChecks",
  "issuesCreated",
  "severeIssues",
  ...RESPONSE_STATES,
]);

/** @typedef {{ siteId: string, day: string } & Record<string, any>} SiteDay */

/**
 * @typedef {{ siteId: string, checkId: string, status?: string | null, flowType?: string | null,
 *   startedAt?: string | null, completedAt?: string | null, synthesizedAt?: string | null }} CheckRow
 */

/**
 * @param {Map<string, SiteDay>} days
 * @param {string} siteId
 * @param {string} day
 * @returns {SiteDay}
 */
function row(days, siteId, day) {
  const k = `${siteId}|${day}`;
  let r = days.get(k);
  if (!r) {
    r = {
      siteId,
      day,
      ...Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0])),
    };
    days.set(k, r);
  }
  return r;
}

/**
 * @param {{ checks: CheckRow[], issues: import("./issue-facts.js").IssueFact[] }} inputs
 * @param {string} evaluatedAt
 * @returns {{ siteDays: SiteDay[], undatedChecks: number }}
 */
export function buildSiteDays({ checks, issues }, evaluatedAt) {
  const cutoff = Date.parse(evaluatedAt);
  /** @type {Map<string, SiteDay>} */
  const days = new Map();
  let undatedChecks = 0;
  for (const check of checks) {
    // Older headers may lack completedAt; synthesis happens at completion.
    const finishedAt = [check.completedAt, check.synthesizedAt]
      .map((v) => (v ? Date.parse(v) : NaN))
      .find(Number.isFinite);
    const startedAt = check.startedAt ? Date.parse(check.startedAt) : NaN;
    // A Check finished after the snapshot was still unfinished at it.
    const done =
      check.status === "completed" &&
      !(finishedAt !== undefined && finishedAt > cutoff);
    // With no finish time at all, the start day is the best day left.
    const time = done ? (finishedAt ?? startedAt) : startedAt;
    if (!Number.isFinite(time)) {
      undatedChecks += 1;
      continue;
    }
    if (time > cutoff) continue;
    const r = row(days, check.siteId, pacificDateKey(time));
    if (!done) r.unfinishedChecks += 1;
    else if (check.flowType === "single-problem") r.singleIssueReports += 1;
    else r.completedPerimeterChecks += 1;
  }
  for (const issue of issues) {
    const r = row(days, issue.siteId, issue.createdDay);
    r.issuesCreated += 1;
    if (issue.severityBand === "severe") r.severeIssues += 1;
    r[issue.responseState] += 1;
  }
  const siteDays = [...days.values()].sort(
    (a, b) => a.siteId.localeCompare(b.siteId) || a.day.localeCompare(b.day),
  );
  return { siteDays, undatedChecks };
}

/**
 * @param {SiteDay[]} siteDays
 * @param {{ startDay: string, endDay: string }} range endDay exclusive
 * @param {Set<string>} [siteIds] limit to these Sites
 * @returns {{ total: Record<string, number>, bySite: Map<string, Record<string, number>> }}
 */
export function sumSiteDays(siteDays, range, siteIds) {
  const zero = () => Object.fromEntries(SITE_DAY_METRICS.map((m) => [m, 0]));
  const total = zero();
  /** @type {Map<string, Record<string, number>>} */
  const bySite = new Map();
  for (const r of siteDays) {
    if (r.day < range.startDay || r.day >= range.endDay) continue;
    if (siteIds && !siteIds.has(r.siteId)) continue;
    const site = bySite.get(r.siteId) ?? zero();
    for (const m of SITE_DAY_METRICS) {
      site[m] += r[m] ?? 0;
      total[m] += r[m] ?? 0;
    }
    bySite.set(r.siteId, site);
  }
  return { total, bySite };
}

// Never a rate: a drop in Checks may mean fewer days open, not worse work.
/**
 * @param {Record<string, number>} current
 * @param {Record<string, number>} prior
 * @returns {Record<string, { current: number, prior: number, change: number }>}
 */
export function compareTotals(current, prior) {
  return Object.fromEntries(
    SITE_DAY_METRICS.map((m) => [
      m,
      {
        current: current[m] ?? 0,
        prior: prior[m] ?? 0,
        change: (current[m] ?? 0) - (prior[m] ?? 0),
      },
    ]),
  );
}
