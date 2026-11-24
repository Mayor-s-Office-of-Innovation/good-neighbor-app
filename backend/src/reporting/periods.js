// Every screen, CSV and report resolves its period here, so all agree on
// where a day starts.

import {
  PACIFIC_TIME_ZONE,
  addDays,
  addMonthsToFirst,
  dayKeysBetween,
  isDayKey,
  pacificDateKey,
  pacificDayStartIso,
} from "../lib/pacific-dates.js";

/**
 * @typedef {{ kind: "month", month: string }
 *   | { kind: "quarter", year: number, quarter: number }
 *   | { kind: "year", year: number }
 *   | { kind: "financialYear", startYear: number }
 *   | { kind: "custom", startDay: string, endDay: string }} PeriodSpec
 */

/**
 * @typedef {object} Interval
 * @property {string} kind
 * @property {string} startDay first Pacific day, inclusive
 * @property {string} endDay Pacific day after the last, exclusive
 * @property {string} from instant of startDay's Pacific midnight
 * @property {string} to instant of endDay's Pacific midnight, exclusive
 * @property {string} observedTo the earlier of `to` and the evaluation time
 * @property {string} timezone
 * @property {boolean} incomplete
 * @property {boolean} [clipped]
 */

// Marks an error whose code a caller may read; other libraries' errors also carry code and statusCode.
export const REQUEST_ERROR = Symbol("requestError");

/**
 * @param {string} code
 * @returns {Error}
 */
function periodError(code) {
  return Object.assign(new Error(code), {
    code,
    statusCode: 400,
    [REQUEST_ERROR]: true,
  });
}

/**
 * @param {string} kind
 * @param {string} startDay
 * @param {string} endDay
 * @param {string} evaluatedAt
 * @returns {Interval}
 */
function interval(kind, startDay, endDay, evaluatedAt) {
  const from = pacificDayStartIso(startDay);
  const to = pacificDayStartIso(endDay);
  const incomplete = Date.parse(evaluatedAt) < Date.parse(to);
  return {
    kind,
    startDay,
    endDay,
    from,
    to,
    observedTo: incomplete ? new Date(evaluatedAt).toISOString() : to,
    timezone: PACIFIC_TIME_ZONE,
    incomplete,
  };
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isYear(value) {
  return (
    Number.isInteger(value) && Number(value) >= 2000 && Number(value) < 3000
  );
}

/**
 * @param {string} dayKey
 * @param {number} months
 * @returns {string} clamped to a short month's last day
 */
function addMonthsSameDay(dayKey, months) {
  const first = addMonthsToFirst(dayKey, months);
  const day = Number(dayKey.slice(8, 10));
  const lastDay = Number(addDays(addMonthsToFirst(first, 1), -1).slice(8, 10));
  return `${first.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/**
 * @param {PeriodSpec} spec
 * @param {string} evaluatedAt the snapshot's evaluation time
 * @returns {Interval}
 */
export function resolvePeriod(spec, evaluatedAt) {
  // A bad snapshot time would make every period look complete.
  if (!Number.isFinite(Date.parse(evaluatedAt)))
    throw new Error("resolvePeriod needs a valid evaluatedAt");
  /** @type {[string, string]} */
  let days;
  if (spec?.kind === "month") {
    const start = `${spec.month}-01`;
    if (
      !/^\d{4}-\d{2}$/.test(String(spec.month)) ||
      !isDayKey(start) ||
      !isYear(Number(start.slice(0, 4)))
    )
      throw periodError("invalid_month");
    days = [start, addMonthsToFirst(start, 1)];
  } else if (spec?.kind === "quarter") {
    if (!isYear(spec.year)) throw periodError("invalid_year");
    if (![1, 2, 3, 4].includes(spec.quarter))
      throw periodError("invalid_quarter");
    // Calendar quarters, as the field app's reports use: Q3 is July to September.
    const start = `${spec.year}-${String(spec.quarter * 3 - 2).padStart(2, "0")}-01`;
    days = [start, addMonthsToFirst(start, 3)];
  } else if (spec?.kind === "year") {
    if (!isYear(spec.year)) throw periodError("invalid_year");
    days = [`${spec.year}-01-01`, `${spec.year + 1}-01-01`];
  } else if (spec?.kind === "financialYear") {
    if (!isYear(spec.startYear)) throw periodError("invalid_year");
    days = [`${spec.startYear}-07-01`, `${spec.startYear + 1}-07-01`];
  } else if (spec?.kind === "custom") {
    if (
      !isDayKey(spec.startDay) ||
      !isDayKey(spec.endDay) ||
      !isYear(Number(spec.startDay.slice(0, 4)))
    )
      throw periodError("invalid_day");
    if (spec.endDay <= spec.startDay) throw periodError("empty_period");
    if (spec.endDay > addMonthsSameDay(spec.startDay, 12))
      throw periodError("period_too_long");
    days = [spec.startDay, spec.endDay];
  } else throw periodError("invalid_kind");
  const resolved = interval(spec.kind, days[0], days[1], evaluatedAt);
  if (Date.parse(resolved.from) > Date.parse(evaluatedAt))
    throw periodError("future_period");
  return resolved;
}

/**
 * @param {Interval} current
 * @param {string} evaluatedAt
 * @returns {Interval}
 */
export function previousOf(current, evaluatedAt) {
  if (current.kind === "month")
    return interval(
      "month",
      addMonthsToFirst(current.startDay, -1),
      current.startDay,
      evaluatedAt,
    );
  if (current.kind === "quarter")
    return interval(
      "quarter",
      addMonthsToFirst(current.startDay, -3),
      current.startDay,
      evaluatedAt,
    );
  if (current.kind === "year" || current.kind === "financialYear")
    return interval(
      current.kind,
      addMonthsToFirst(current.startDay, -12),
      current.startDay,
      evaluatedAt,
    );
  const length = dayKeysBetween(current.startDay, current.endDay).length;
  return interval(
    current.kind,
    addDays(current.startDay, -length),
    current.startDay,
    evaluatedAt,
  );
}

/**
 * Partial periods compare the same count of complete days; prior is null on
 * day one. Today is left out of both sides, because day totals can't split a
 * day at the snapshot hour.
 * @param {Interval} current
 * @param {string} evaluatedAt
 * @returns {{ basis: "complete_period" | "elapsed_complete_days" | "not_enough_elapsed", days: number, priorDays: number, current: Interval, prior: Interval | null }}
 */
export function comparisonFor(current, evaluatedAt) {
  const prior = previousOf(current, evaluatedAt);
  // Judge completeness now, in case `current` was resolved at another time.
  if (Date.parse(evaluatedAt) >= Date.parse(current.to))
    return {
      basis: "complete_period",
      days: dayKeysBetween(current.startDay, current.endDay).length,
      priorDays: dayKeysBetween(prior.startDay, prior.endDay).length,
      current,
      prior,
    };
  const today = pacificDateKey(evaluatedAt);
  const days = dayKeysBetween(current.startDay, today).length;
  if (days <= 0)
    return {
      basis: "not_enough_elapsed",
      days: 0,
      priorDays: 0,
      current,
      prior: null,
    };
  const alignedEnd = addDays(prior.startDay, days);
  const clipped = alignedEnd > prior.endDay;
  // A shorter prior, e.g. February, cuts the current side too, so totals compare equal days.
  const compared = clipped
    ? dayKeysBetween(prior.startDay, prior.endDay).length
    : days;
  return {
    basis: "elapsed_complete_days",
    days: compared,
    priorDays: compared,
    current: interval(
      current.kind,
      current.startDay,
      clipped ? addDays(current.startDay, compared) : today,
      evaluatedAt,
    ),
    prior: {
      ...interval(
        prior.kind,
        prior.startDay,
        clipped ? prior.endDay : alignedEnd,
        evaluatedAt,
      ),
      clipped,
    },
  };
}
