/*
  Per-day check compliance. The site's duty is `requiredChecksPerDay`
  perimeter checks on every Pacific calendar day inside its compliance
  period. Nothing is written for a check that never happened, so a missed
  check is derived here: the day's requirement minus the completed perimeter
  checks that day. Pure functions over CHECK# headers; the handler queries,
  this module counts.
*/
import { pacificDateKey } from "../lib/pacific-dates.js";

/**
 * @typedef {"complete" | "partial" | "missed" | "pending" | "upcoming" | "exempt"} DayStatus
 *   complete: the requirement was met.
 *   partial:  a past day with some but not all required checks.
 *   missed:   a past day with no checks at all.
 *   pending:  today, requirement not yet met.
 *   upcoming: a future day.
 *   exempt:   no requirement applied that day (outside the compliance
 *             period, or checks are not required).
 */

/**
 * @typedef {object} DaySummary
 * @property {string} date Pacific day key
 * @property {DayStatus} status
 * @property {number} required checks required that day (0 when exempt)
 * @property {number} completed completed perimeter checks that day
 * @property {number} reports completed single-issue reports that day
 * @property {number} issueCount issues found across every completed check
 * @property {string[]} checkIds completed checks and reports, oldest first
 */

/**
 * @typedef {object} ComplianceTotals
 * @property {number} possible required checks over the elapsed days
 * @property {number} completed completed checks counted against the
 *   requirement (capped at each day's requirement)
 * @property {number} recorded every completed perimeter check, uncapped
 * @property {number} missed required checks that never happened on past days
 * @property {number} issueCount issues found over the period
 */

/** The city-wide norm, used when a site has no cadence of its own yet. */
export const DEFAULT_REQUIRED_CHECKS_PER_DAY = 3;

/**
 * @typedef {object} Requirement
 * @property {number} requiredPerDay
 * @property {boolean} required whether perimeter checks are required at all
 * @property {boolean} [assumed] true when no cadence is configured and the
 *   city-wide default stands in for it
 * @property {string} [periodStart] first day the requirement applies
 * @property {string} [periodEnd] last day the requirement applies (inclusive)
 */

/**
 * The site's requirement as stored on `#META.compliance`. A site with no
 * configured cadence is measured against the city-wide default so its
 * report is meaningful from day one; an explicit "not required" is kept.
 * @param {Record<string, any> | undefined} compliance
 * @returns {Requirement}
 */
export function requirementFromCompliance(compliance) {
  const perDay = Number(compliance?.requiredChecksPerDay);
  const configured = Number.isInteger(perDay) && perDay > 0;
  return {
    requiredPerDay: configured ? perDay : DEFAULT_REQUIRED_CHECKS_PER_DAY,
    required: compliance?.perimeterChecksRequired !== false,
    assumed: !configured,
    ...(compliance?.periodStart ? { periodStart: compliance.periodStart } : {}),
    ...(compliance?.periodEnd ? { periodEnd: compliance.periodEnd } : {}),
  };
}

/**
 * How many checks the site owed on one day.
 * @param {Requirement} requirement
 * @param {string} dayKey
 */
export function requiredOn(requirement, dayKey) {
  if (!requirement.required || requirement.requiredPerDay < 1) return 0;
  if (requirement.periodStart && dayKey < requirement.periodStart) return 0;
  if (requirement.periodEnd && dayKey > requirement.periodEnd) return 0;
  return requirement.requiredPerDay;
}

/**
 * @param {{ required: number, completed: number }} day
 * @param {string} dayKey
 * @param {string} today
 * @returns {DayStatus}
 */
export function dayStatus(day, dayKey, today) {
  if (day.required === 0) return "exempt";
  if (dayKey > today) return "upcoming";
  if (day.completed >= day.required) return "complete";
  if (dayKey === today) return "pending";
  return day.completed > 0 ? "partial" : "missed";
}

/**
 * @param {Record<string, any>} header a CHECK# header
 */
function isCompleted(header) {
  return header?.status === "completed";
}

/** @param {Record<string, any>} header */
function isPerimeter(header) {
  return header.flowType !== "single-problem";
}

/** @param {Record<string, any>} header */
function occurredOn(header) {
  return pacificDateKey(header.startedAt || header.completedAt || "");
}

/**
 * Summarize one period, day by day.
 * @param {object} input
 * @param {Array<Record<string, any>>} input.checks CHECK# headers in any order
 * @param {string[]} input.dayKeys the period's days, ascending
 * @param {string} input.today Pacific day key
 * @param {Requirement} input.requirement
 * @returns {{ days: DaySummary[], totals: ComplianceTotals }}
 */
export function summarizeCheckDays({ checks, dayKeys, today, requirement }) {
  /** @type {Map<string, Array<Record<string, any>>>} */
  const byDay = new Map();
  for (const header of checks) {
    if (!isCompleted(header)) continue;
    const key = occurredOn(header);
    if (!key) continue;
    const list = byDay.get(key) ?? [];
    list.push(header);
    byDay.set(key, list);
  }

  const totals = {
    possible: 0,
    completed: 0,
    recorded: 0,
    missed: 0,
    issueCount: 0,
  };
  const days = dayKeys.map((date) => {
    const headers = (byDay.get(date) ?? []).sort((a, b) =>
      String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")),
    );
    const completed = headers.filter(isPerimeter).length;
    const reports = headers.length - completed;
    const issueCount = headers.reduce(
      (sum, h) => sum + (Number(h.issueCount) || 0),
      0,
    );
    const required = requiredOn(requirement, date);
    const status = dayStatus({ required, completed }, date, today);

    if (date <= today) {
      const counted = Math.min(completed, required);
      totals.possible += required;
      totals.completed += counted;
      totals.recorded += completed;
      totals.issueCount += issueCount;
      if (date < today) totals.missed += required - counted;
    }

    return {
      date,
      status,
      required,
      completed,
      reports,
      issueCount,
      checkIds: headers.map((h) => String(h.checkId ?? "")),
    };
  });

  return { days, totals };
}
