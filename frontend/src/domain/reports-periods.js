/*
  reports-periods — the calendar arithmetic and bucketing behind the site
  manager reports. Pure functions over Pacific day keys (YYYY-MM-DD) and the
  backend's day summaries; no DOM, no fetch. Labels that a user sees go
  through t() and the dates module, never a fixed locale.

  Day keys are treated as UTC-midnight stamps for arithmetic only; the
  backend already resolved every instant to its Pacific day.
*/
import { t } from "../i18n/i18n.js";
import { formatDateTime, formatMonthDay } from "../i18n/dates.js";

/** @typedef {"week" | "month" | "quarter"} PeriodKind */
/** @typedef {{ kind: PeriodKind, start: string, endExclusive: string }} Period */
/**
 * @typedef {object} DaySummary the backend's per-day record (AP27)
 * @property {string} date
 * @property {"complete" | "partial" | "missed" | "pending" | "upcoming" | "exempt"} status
 * @property {boolean} [operating] explicit site operating-day information, when available
 * @property {number} required
 * @property {number} completed
 * @property {number} reports
 * @property {number} issueCount
 * @property {Array<{checkId: string, startedAt: string, photoCount: number, issueCount?: number, resolvedCount?: number}>} [checks]
 * @property {string[]} checkIds
 */

export const PERIOD_KINDS = /** @type {PeriodKind[]} */ ([
  "week",
  "month",
  "quarter",
]);

const DAY_MS = 86_400_000;

/** @param {unknown} value @returns {value is PeriodKind} */
export function isPeriodKind(value) {
  return value === "week" || value === "month" || value === "quarter";
}

/** @param {unknown} value @returns {value is string} */
export function isDayKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** @param {string} dayKey */
function stamp(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** @param {number} value */
function key(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/** An instant inside the Pacific day, for formatting its calendar fields. */
export function dayInstant(dayKey) {
  // 20:00Z is noon or 13:00 Pacific in either DST state.
  return new Date(`${dayKey}T20:00:00.000Z`);
}

/** @param {string} dayKey @param {number} days */
export function addDays(dayKey, days) {
  return key(stamp(dayKey) + days * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. @param {string} dayKey */
export function weekdayIndex(dayKey) {
  return new Date(stamp(dayKey)).getUTCDay();
}

/** @param {string} dayKey @param {number} months */
function addMonthsToFirst(dayKey, months) {
  const [y, m] = dayKey.split("-").map(Number);
  return key(Date.UTC(y, m - 1 + months, 1));
}

/**
 * The period of `kind` containing `dayKey`. Mirrors the backend
 * (`backend/src/lib/pacific-dates.js`): Sunday-start weeks, calendar
 * months and quarters.
 * @param {PeriodKind} kind
 * @param {string} dayKey
 * @returns {Period}
 */
export function periodContaining(kind, dayKey) {
  if (kind === "week") {
    const start = addDays(dayKey, -weekdayIndex(dayKey));
    return { kind, start, endExclusive: addDays(start, 7) };
  }
  if (kind === "month") {
    const start = addMonthsToFirst(dayKey, 0);
    return { kind, start, endExclusive: addMonthsToFirst(start, 1) };
  }
  const [y, m] = dayKey.split("-").map(Number);
  const quarterMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const start = `${y}-${String(quarterMonth).padStart(2, "0")}-01`;
  return { kind, start, endExclusive: addMonthsToFirst(start, 3) };
}

/**
 * Every day key from `start` up to but excluding `endExclusive`.
 * @param {string} start
 * @param {string} endExclusive
 * @returns {string[]}
 */
export function dayKeysBetween(start, endExclusive) {
  const keys = [];
  for (let at = stamp(start); at < stamp(endExclusive); at += DAY_MS) {
    keys.push(key(at));
  }
  return keys;
}

/** @param {Period} period @returns {Period} */
export function previousPeriod(period) {
  return periodContaining(period.kind, addDays(period.start, -1));
}

/** The last day of a period (inclusive). @param {Period} period */
export function periodEnd(period) {
  return addDays(period.endExclusive, -1);
}

/**
 * A period's name for the picker and headings: "Q3 2026", "Sep 2026",
 * "Sep 20–26" or "Sep 27 – Oct 3".
 * @param {Period} period
 */
export function periodLabel(period) {
  if (period.kind === "quarter") {
    const [y, m] = period.start.split("-").map(Number);
    return t("reports.period.quarter", {
      quarter: Math.floor((m - 1) / 3) + 1,
      year: y,
    });
  }
  if (period.kind === "month") {
    return formatDateTime(dayInstant(period.start), {
      month: "short",
      year: "numeric",
    });
  }
  const end = periodEnd(period);
  const sameMonth = period.start.slice(0, 7) === end.slice(0, 7);
  const first = formatMonthDay(dayInstant(period.start));
  const last = sameMonth
    ? formatDateTime(dayInstant(end), { day: "numeric" })
    : formatMonthDay(dayInstant(end));
  return t(
    sameMonth ? "reports.period.weekSameMonth" : "reports.period.weekSpan",
    {
      first,
      last,
    },
  );
}

/**
 * The periods the picker offers: the current one and `count - 1` before it.
 * @param {PeriodKind} kind
 * @param {string} today
 * @param {number} [count]
 * @returns {Period[]} newest first
 */
export function periodOptions(kind, today, count = 8) {
  const options = [];
  let period = periodContaining(kind, today);
  for (let i = 0; i < count; i += 1) {
    options.push(period);
    period = previousPeriod(period);
  }
  return options;
}

/**
 * Completion rate in whole percentage points, or null when nothing was owed.
 * @param {{ possible: number, completed: number }} totals
 * @returns {number | null}
 */
export function completionPercent(totals) {
  if (!totals || !(totals.possible > 0)) return null;
  return Math.round((100 * totals.completed) / totals.possible);
}

/**
 * The headline's second line: percentage points against the previous period.
 * @param {{ possible: number, completed: number }} totals
 * @param {{ possible: number, completed: number }} previousTotals
 * @param {PeriodKind} kind
 * @returns {string}
 */
export function rateDeltaLine(totals, previousTotals, kind) {
  const now = completionPercent(totals);
  const before = completionPercent(previousTotals);
  if (now === null || before === null) return t("reports.delta.noPrevious");
  const points = now - before;
  const previous = t(`reports.period.previous.${kind}`);
  if (points === 0) return t("reports.delta.same", { previous });
  return t(points > 0 ? "reports.delta.higher" : "reports.delta.lower", {
    count: Math.abs(points),
    previous,
  });
}

/**
 * A count against the previous period: "4 more than the previous month".
 * @param {number} current
 * @param {number} previous
 * @param {PeriodKind} kind
 */
export function countDeltaLine(current, previous, kind) {
  const previousLabel = t(`reports.period.previous.${kind}`);
  const diff = current - previous;
  if (diff === 0)
    return t("reports.delta.sameCount", { previous: previousLabel });
  return t(diff > 0 ? "reports.delta.more" : "reports.delta.fewer", {
    count: Math.abs(diff),
    previous: previousLabel,
  });
}

/**
 * The days that belong in the records list: anything that was owed and has
 * started, newest first.
 * @param {DaySummary[]} days
 */
export function recordDays(days) {
  return days.filter(isRecordDay).slice().reverse();
}

/**
 * A day belongs in the records when something was owed and the day has
 * started, or when checks were recorded even though nothing was owed (a
 * site with no configured cadence still sees its checks).
 * @param {DaySummary} day
 */
export function isRecordDay(day) {
  return (
    ["complete", "partial", "missed", "pending"].includes(day.status) ||
    (day.status === "exempt" && hasRecordedChecks(day))
  );
}

/**
 * Whether anything was recorded on a day that owed nothing: a completed
 * perimeter check or a single-issue report (both carry check IDs and a day
 * detail).
 * @param {DaySummary} day
 */
export function hasRecordedChecks(day) {
  return day.completed > 0 || (day.reports ?? 0) > 0;
}

/**
 * "Today, Sep 30" / "Yesterday, Sep 29" / "Wednesday, Sep 28".
 * @param {string} dayKey
 * @param {string} today
 */
export function dayTitle(dayKey, today) {
  const instant = dayInstant(dayKey);
  const date = formatMonthDay(instant);
  if (dayKey === today) return t("reports.day.today", { date });
  if (dayKey === addDays(today, -1))
    return t("reports.day.yesterday", { date });
  return t("reports.day.weekday", {
    weekday: formatDateTime(instant, { weekday: "long" }),
    date,
  });
}

/**
 * @typedef {object} WeekBucket one column of the quarter chart
 * @property {string} start Sunday
 * @property {number} complete
 * @property {number} partial
 * @property {number} missed
 * @property {number} recorded exempt days that still had checks (nothing owed)
 * @property {number} open pending + upcoming + exempt without checks
 * @property {string} [monthLabel] set on the first week that contains the 1st of a month
 */

/**
 * Group a period's days into Sunday-start weeks for the stacked chart.
 * @param {DaySummary[]} days ascending
 * @returns {WeekBucket[]}
 */
export function weekBuckets(days) {
  /** @type {Map<string, WeekBucket>} */
  const weeks = new Map();
  for (const day of days) {
    const start = addDays(day.date, -weekdayIndex(day.date));
    let bucket = weeks.get(start);
    if (!bucket) {
      bucket = {
        start,
        complete: 0,
        partial: 0,
        missed: 0,
        recorded: 0,
        open: 0,
      };
      weeks.set(start, bucket);
    }
    if (day.status === "complete") bucket.complete += 1;
    else if (day.status === "partial") bucket.partial += 1;
    else if (day.status === "missed") bucket.missed += 1;
    else if (day.status === "exempt" && hasRecordedChecks(day))
      bucket.recorded += 1;
    else bucket.open += 1;
    if (day.date.endsWith("-01")) {
      bucket.monthLabel = formatDateTime(dayInstant(day.date), {
        month: "short",
      });
    }
  }
  return [...weeks.values()];
}

/**
 * Calendar cells for a month or week grid: leading blanks so the first day
 * lands under its weekday column, then one cell per day.
 * @param {DaySummary[]} days ascending
 * @returns {Array<DaySummary | null>}
 */
export function calendarCells(days) {
  if (!days.length) return [];
  const blanks = Array.from({ length: weekdayIndex(days[0].date) }, () => null);
  return [...blanks, ...days];
}

/**
 * Localized one-letter weekday headers, Sunday first.
 * @returns {string[]}
 */
export function weekdayInitials() {
  // 2026-09-27 is a Sunday.
  return Array.from({ length: 7 }, (_, i) =>
    formatDateTime(dayInstant(addDays("2026-09-27", i)), { weekday: "narrow" }),
  );
}

/**
 * The records list as CSV, one row per day.
 * @param {DaySummary[]} days
 * @returns {string}
 */
export function daysToCsv(days) {
  const header = [
    "date",
    "status",
    "required",
    "completed",
    "reports",
    "issues",
  ];
  const rows = days.map((d) => [
    d.date,
    d.status,
    d.required,
    d.completed,
    d.reports,
    d.issueCount,
  ]);
  return [header, ...rows].map((row) => row.join(",")).join("\n") + "\n";
}
