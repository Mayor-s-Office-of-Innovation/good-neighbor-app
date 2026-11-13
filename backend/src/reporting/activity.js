// The Site-day metrics every Insights page sums, so they never recount.

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
