// The Site-day metrics every Insights page sums, so they never recount.

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
 * @typedef {object} CheckFact
 * @property {string} checkId
 * @property {string} siteId
 * @property {string} source perimeter or single-problem
 * @property {string} state completed or unfinished, as of the snapshot
 * @property {string | null} startedAt
 * @property {string | null} completedAt
 * @property {string} activityAt completion time if completed, else start time
 * @property {string} day Pacific day of activityAt
 * @property {number} issues canonical Issues raised from this Check
 */

// Places a Check as rule 8 in projection-sql.js does for the day totals.
/**
 * @param {CheckRow} check
 * @param {number} cutoff snapshot time in ms
 * @returns {{ skip: "undated" | "future" } | { skip: null, done: boolean, time: number, finishedAt: number | undefined }}
 */
function placeCheck(check, cutoff) {
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
  if (!Number.isFinite(time)) return { skip: "undated" };
  if (time > cutoff) return { skip: "future" };
  return { skip: null, done, time, finishedAt: done ? finishedAt : undefined };
}

// No device or staff name: the app keeps no device snapshot on Checks.
/**
 * @param {{ checks: CheckRow[], issues: { siteId: string, checkId?: string | null }[] }} inputs
 * @param {string} evaluatedAt
 * @returns {{ checks: CheckFact[], undatedChecks: number }}
 */
export function buildCheckFacts({ checks, issues }, evaluatedAt) {
  const cutoff = Date.parse(evaluatedAt);
  /** @type {Map<string, number>} */
  const issuesByCheck = new Map();
  for (const issue of issues) {
    if (!issue.checkId) continue;
    const k = `${issue.siteId}|${issue.checkId}`;
    issuesByCheck.set(k, (issuesByCheck.get(k) ?? 0) + 1);
  }
  /** @type {CheckFact[]} */
  const facts = [];
  let undatedChecks = 0;
  for (const check of checks) {
    const placed = placeCheck(check, cutoff);
    if (placed.skip === "undated") undatedChecks += 1;
    if (placed.skip !== null) continue;
    const activityAt = new Date(placed.time).toISOString();
    facts.push({
      checkId: String(check.checkId),
      siteId: String(check.siteId),
      source:
        check.flowType === "single-problem" ? "single-problem" : "perimeter",
      state: placed.done ? "completed" : "unfinished",
      // Same form as the other times, so text sorts and CSV columns match.
      startedAt: Number.isFinite(Date.parse(check.startedAt ?? ""))
        ? new Date(
            Date.parse(/** @type {string} */ (check.startedAt)),
          ).toISOString()
        : null,
      completedAt:
        placed.finishedAt === undefined
          ? null
          : new Date(placed.finishedAt).toISOString(),
      activityAt,
      day: pacificDateKey(placed.time),
      issues: issuesByCheck.get(`${check.siteId}|${check.checkId}`) ?? 0,
    });
  }
  facts.sort(
    (a, b) =>
      a.siteId.localeCompare(b.siteId) ||
      a.activityAt.localeCompare(b.activityAt) ||
      a.checkId.localeCompare(b.checkId),
  );
  return { checks: facts, undatedChecks };
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
