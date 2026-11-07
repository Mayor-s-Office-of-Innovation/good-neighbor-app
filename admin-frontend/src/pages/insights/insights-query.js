// Kept in the URL, so a link, Back or a return from Manage reopens the same view.
import { addDays } from "../../../../frontend/src/domain/reports-periods.js";
import { pacificDateKey } from "../../../../frontend/src/i18n/dates.js";

/**
 * @typedef {{ kind: "month", month: string }
 *   | { kind: "quarter", year: number, quarter: number }
 *   | { kind: "year", year: number }
 *   | { kind: "financialYear", startYear: number }
 *   | { kind: "custom", from: string, to: string }} Period
 *   custom `to` is the last day shown, inclusive
 */

/** @typedef {ReturnType<typeof readOverview>} OverviewState */

// The server refuses a report of more Sites, so picking stops here.
export const MAX_REPORT_SITES = 2000;

// In the order the Show control lists them.
export const SHOW = ["all", "top", "unknown"];
// One list, so Clear filters and the empty-state check reset the same ones.
export const OVERVIEW_FILTERS = /** @type {const} */ ([
  "managerId",
  "providerId",
  "department",
]);
// Only sorts the server accepts, so a shared link never asks for one it refuses.
export const SITE_SORTS = [
  "name",
  "completedPerimeterChecks",
  "overdueLate",
  "maxSeverity",
  "issuesCreated",
];
// Matches SORTS.sites' defaults, so a column's first click sends no dir.
/** @type {Record<string, "asc" | "desc">} */
export const SITE_SORT_DIR = {
  name: "asc",
  completedPerimeterChecks: "asc",
  overdueLate: "desc",
  maxSeverity: "desc",
  issuesCreated: "desc",
};

// Years 2000–2999, the only years the server accepts.
const DAY = /^2\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^2\d{3}-(0[1-9]|1[0-2])$/;
const QUARTER = /^(2\d{3})-Q([1-4])$/;
const YEAR = /^2\d{3}$/;
// Free-text filters are IDs or names; anything longer is a crafted link.
const MAX_VALUE = 200;
// The server refuses a longer search rather than cutting it.
export const MAX_SEARCH = 100;

/** Feb 30 passes the pattern, but the server refuses it. @param {string} day */
const isDay = (day) => DAY.test(day) && addDays(day, 0) === day;

/** Clamps to a short month's last day, as the server does, so both cap periods alike. @param {string} day @param {number} months */
function addMonths(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** @param {URLSearchParams} params @param {Date} now @returns {Period | null} */
function periodIn(params, now) {
  const value = params.get("period") || "";
  if (MONTH.test(value)) return { kind: "month", month: value };
  const quarter = QUARTER.exec(value);
  if (quarter)
    return {
      kind: "quarter",
      year: Number(quarter[1]),
      quarter: Number(quarter[2]),
    };
  if (YEAR.test(value)) return { kind: "year", year: Number(value) };
  if (/^fy2\d{3}$/.test(value))
    return { kind: "financialYear", startYear: Number(value.slice(2)) };
  if (value !== "custom") return null;
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  return customPeriodError(from, to, now) ? null : { kind: "custom", from, to };
}

/**
 * A period the server refuses, such as one not started yet, would leave the
 * page with no period to step from, so it falls back to the default month.
 * @param {string} search
 * @param {Date} [now]
 * @returns {Period | null} null for the server's default month
 */
export function readPeriod(search, now = new Date()) {
  const period = periodIn(new URLSearchParams(search), now);
  return period && !hasStarted(period, now) ? null : period;
}

/** @param {Period | null} period @returns {Record<string, string>} */
export function periodApiParams(period) {
  if (!period) return {};
  if (period.kind === "month") return { period: "month", month: period.month };
  if (period.kind === "quarter")
    return {
      period: "quarter",
      year: `${period.year}`,
      quarter: `${period.quarter}`,
    };
  if (period.kind === "year") return { period: "year", year: `${period.year}` };
  if (period.kind === "financialYear")
    return { period: "financialYear", startYear: `${period.startYear}` };
  // The API's end is the day after the last one, as every period's is.
  return { period: "custom", from: period.from, to: addDays(period.to, 1) };
}

/** @param {string} day @returns {Period} the calendar quarter holding it */
export function quarterOf(day) {
  return {
    kind: "quarter",
    year: Number(day.slice(0, 4)),
    quarter: Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1,
  };
}

/** @param {number} year @param {number} quarter */
const quarterStart = (year, quarter) =>
  `${year}-${String(quarter * 3 - 2).padStart(2, "0")}-01`;

/** So Previous and Next work before the URL names a period. @param {{ kind: string, startDay: string, endDay: string }} interval @returns {Period} */
export function periodOf(interval) {
  const start = interval.startDay;
  if (interval.kind === "quarter") return quarterOf(start);
  if (interval.kind === "year")
    return { kind: "year", year: Number(start.slice(0, 4)) };
  if (interval.kind === "financialYear")
    return { kind: "financialYear", startYear: Number(start.slice(0, 4)) };
  if (interval.kind === "custom")
    return { kind: "custom", from: start, to: addDays(interval.endDay, -1) };
  return { kind: "month", month: start.slice(0, 7) };
}

/**
 * For the controls before a reply names the days. A period holding today
 * is running, so Next can't step into one that hasn't started.
 * @param {Period} period
 * @param {Date} [now]
 */
export function intervalOf(period, now = new Date()) {
  const today = pacificDateKey(now);
  /** @param {string} startDay @param {string} endDay */
  const days = (startDay, endDay) => {
    const incomplete = endDay > today;
    return {
      kind: period.kind,
      startDay,
      endDay,
      incomplete,
      ...(incomplete ? { observedTo: now.toISOString() } : {}),
    };
  };
  if (period.kind === "month")
    return days(`${period.month}-01`, addMonths(`${period.month}-01`, 1));
  if (period.kind === "quarter") {
    const start = quarterStart(period.year, period.quarter);
    return days(start, addMonths(start, 3));
  }
  if (period.kind === "year")
    return days(`${period.year}-01-01`, `${period.year + 1}-01-01`);
  if (period.kind === "financialYear")
    return days(`${period.startYear}-07-01`, `${period.startYear + 1}-07-01`);
  return days(period.from, addDays(period.to, 1));
}

/** Compared by URL form, which names each period one way. @param {Period | null} a @param {Period | null} b */
export const samePeriod = (a, b) =>
  periodSearch(a).toString() === periodSearch(b).toString();

/** @param {Period | null} period */
export function periodSearch(period) {
  const params = new URLSearchParams();
  if (!period) return params;
  if (period.kind === "month") params.set("period", period.month);
  else if (period.kind === "quarter")
    params.set("period", `${period.year}-Q${period.quarter}`);
  else if (period.kind === "year") params.set("period", `${period.year}`);
  else if (period.kind === "financialYear")
    params.set("period", `fy${period.startYear}`);
  else {
    params.set("period", "custom");
    params.set("from", period.from);
    params.set("to", period.to);
  }
  return params;
}

/** @param {Period} period @param {Date} now */
const hasStarted = (period, now) =>
  intervalOf(period, now).startDay <= pacificDateKey(now);

/** @param {Period} period not custom @param {1 | -1} step */
function stepped(period, step) {
  if (period.kind === "month")
    return {
      kind: "month",
      month: addMonths(`${period.month}-01`, step).slice(0, 7),
    };
  if (period.kind === "quarter")
    return quarterOf(
      addMonths(quarterStart(period.year, period.quarter), 3 * step),
    );
  if (period.kind === "year") return { kind: "year", year: period.year + step };
  if (period.kind === "financialYear")
    return { kind: "financialYear", startYear: period.startYear + step };
  return period;
}

/** @param {Period} period not custom @param {1 | -1} step @returns {Period} the same period when the step would leave the years the server takes */
export function stepPeriod(period, step) {
  const next = /** @type {Period} */ (stepped(period, step));
  return YEAR.test(intervalOf(next).startDay.slice(0, 4)) ? next : period;
}

/** @param {string} from @param {string} to last day, inclusive @param {Date} [now] @returns {string} a translation key, or "" */
export function customPeriodError(from, to, now = new Date()) {
  if (!from || !to) return "admin.insights.period.missingDay";
  if (!isDay(from) || !isDay(to)) return "admin.insights.period.invalidDay";
  if (to < from) return "admin.insights.period.endBeforeStart";
  // The server refuses a period that starts after today.
  if (from > pacificDateKey(now)) return "admin.insights.error.futurePeriod";
  // The server caps a period at 12 months from its first day, end exclusive.
  if (addDays(to, 1) > addMonths(from, 12))
    return "admin.insights.error.periodTooLong";
  return "";
}

/** @param {URLSearchParams} params @param {string} key @param {string[] | null} allowed null for free text @param {string} [fallback] @param {number} [max] */
function pick(params, key, allowed, fallback = "", max = MAX_VALUE) {
  const value = (params.get(key) || "").trim();
  if (!value || value.length > max) return fallback;
  return !allowed || allowed.includes(value) ? value : fallback;
}

/** @param {string} search */
export function readOverview(search) {
  const params = new URLSearchParams(search);
  return {
    q: pick(params, "q", null, "", MAX_SEARCH),
    // Top concerns opens first, so Sites needing attention lead; "all" must be asked for.
    show: pick(params, "show", SHOW, "top"),
    managerId: pick(params, "managerId", null),
    providerId: pick(params, "providerId", null),
    department: pick(params, "department", null),
    sort: pick(params, "sort", SITE_SORTS, "name"),
    // Empty means the column's own first direction.
    dir: pick(params, "dir", ["asc", "desc"]),
    // Kept out of the URL: every Site's ID would make each Site link too long to load.
    /** @type {string[]} */
    selected: [],
  };
}

const DEFAULTS = readOverview("");
const FILTER_KEYS = /** @type {const} */ ([
  "q",
  "show",
  ...OVERVIEW_FILTERS,
  "sort",
  "dir",
]);

/** @param {OverviewState} state @returns {"asc" | "desc"} */
export function sortDir(state) {
  return /** @type {"asc" | "desc"} */ (state.dir || SITE_SORT_DIR[state.sort]);
}

/** @param {OverviewState} state @param {Period | null} period @returns {string} "" or "?…" */
export function overviewSearch(state, period) {
  const params = periodSearch(period);
  for (const key of FILTER_KEYS)
    if (state[key] !== DEFAULTS[key]) params.set(key, state[key]);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** The selection stays in the browser until a report is asked for. @param {OverviewState} state @param {Period | null} period */
export function overviewApiParams(state, period) {
  /** @type {Record<string, string>} */
  const params = { ...periodApiParams(period) };
  for (const key of FILTER_KEYS) if (state[key]) params[key] = state[key];
  return params;
}

/** A report never holds a Site the user can't see in the list. @param {string[]} selected @param {string[]} listedIds */
export function keptSelection(selected, listedIds) {
  const listed = new Set(listedIds);
  return selected.filter((id) => listed.has(id)).slice(0, MAX_REPORT_SITES);
}
