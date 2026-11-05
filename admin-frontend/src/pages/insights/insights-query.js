// Kept in the URL, so a link, Back or a return from Manage reopens the same view.
import { addDays } from "../../../../frontend/src/domain/reports-periods.js";
import { pacificDateKey } from "../../../../frontend/src/i18n/dates.js";

/**
 * @typedef {{ kind: "month", month: string }
 *   | { kind: "year", year: number }
 *   | { kind: "financialYear", startYear: number }
 *   | { kind: "custom", from: string, to: string }} Period
 *   custom `to` is the last day shown, inclusive
 */

/** @typedef {ReturnType<typeof readOverview>} OverviewState */

// Matches LIMITS.maxReportSites, so picking stops before the server refuses.
export const MAX_REPORT_SITES = 250;

// The mock's order; Top concerns stays the default (plan §7).
export const SHOW = ["all", "top", "unknown"];
// One list, so Clear filters and the empty-state check reset the same ones.
export const OVERVIEW_FILTERS = /** @type {const} */ ([
  "managerId",
  "providerId",
  "department",
]);
// Matches SORTS.sites, so a shared link never asks for a sort it refuses.
export const SITE_SORTS = [
  "name",
  "overdueLate",
  "maxSeverity",
  "completedPerimeterChecks",
  "issuesCreated",
];

// Years 2000–2999, as the server's isYear accepts.
const DAY = /^2\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^2\d{3}-(0[1-9]|1[0-2])$/;
const YEAR = /^2\d{3}$/;
// Free-text filters are IDs or names; anything longer is a crafted link.
const MAX_VALUE = 200;
// The handler's LIMITS.maxSearch; a longer search is refused, not cut.
export const MAX_SEARCH = 100;

/** Feb 30 passes the pattern, but the server refuses it. @param {string} day */
const isDay = (day) => DAY.test(day) && addDays(day, 0) === day;

/** Clamps as the server's addMonthsSameDay does, so both cap periods alike. @param {string} day @param {number} months */
function addMonths(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** @param {string} search @returns {Period | null} null for the server's current month */
export function readPeriod(search) {
  const params = new URLSearchParams(search);
  const value = params.get("period") || "";
  if (MONTH.test(value)) return { kind: "month", month: value };
  if (YEAR.test(value)) return { kind: "year", year: Number(value) };
  if (/^fy2\d{3}$/.test(value))
    return { kind: "financialYear", startYear: Number(value.slice(2)) };
  if (value === "custom") {
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    // A range the server refuses would leave the page with no period to step from.
    if (!customPeriodError(from, to)) return { kind: "custom", from, to };
  }
  return null;
}

/** @param {Period | null} period @returns {Record<string, string>} */
export function periodApiParams(period) {
  if (!period) return {};
  if (period.kind === "month") return { period: "month", month: period.month };
  if (period.kind === "year") return { period: "year", year: `${period.year}` };
  if (period.kind === "financialYear")
    return { period: "financialYear", startYear: `${period.startYear}` };
  // The API's end is the day after the last one, as every period's is.
  return { period: "custom", from: period.from, to: addDays(period.to, 1) };
}

/** So Previous and Next work before the URL names a period. @param {{ kind: string, startDay: string, endDay: string }} interval @returns {Period} */
export function periodOf(interval) {
  const start = interval.startDay;
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
  if (period.kind === "year")
    return days(`${period.year}-01-01`, `${period.year + 1}-01-01`);
  if (period.kind === "financialYear")
    return days(`${period.startYear}-07-01`, `${period.startYear + 1}-07-01`);
  return days(period.from, addDays(period.to, 1));
}

/** Compared by URL form, which names each period one way. @param {Period | null} a @param {Period | null} b */
export const samePeriod = (a, b) =>
  periodSearch(a).toString() === periodSearch(b).toString();

/** For the controls when neither the URL nor a reply names a period. @param {Date} [now] @returns {Period} */
export const currentMonth = (now = new Date()) => ({
  kind: "month",
  month: pacificDateKey(now).slice(0, 7),
});

/** @param {Period | null} period */
export function periodSearch(period) {
  const params = new URLSearchParams();
  if (!period) return params;
  if (period.kind === "month") params.set("period", period.month);
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

/** @param {Period} period not custom @param {1 | -1} step @returns {Period} */
export function stepPeriod(period, step) {
  if (period.kind === "month")
    return {
      kind: "month",
      month: addMonths(`${period.month}-01`, step).slice(0, 7),
    };
  if (period.kind === "year") return { kind: "year", year: period.year + step };
  if (period.kind === "financialYear")
    return { kind: "financialYear", startYear: period.startYear + step };
  return period;
}

/** @param {string} from @param {string} to last day, inclusive @returns {string} a translation key, or "" */
export function customPeriodError(from, to) {
  if (!from || !to) return "admin.insights.period.missingDay";
  if (!isDay(from) || !isDay(to)) return "admin.insights.period.invalidDay";
  if (to < from) return "admin.insights.period.endBeforeStart";
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
    // Top concerns opens first (plan §7); "all" must be asked for.
    show: pick(params, "show", SHOW, "top"),
    managerId: pick(params, "managerId", null),
    providerId: pick(params, "providerId", null),
    department: pick(params, "department", null),
    sort: pick(params, "sort", SITE_SORTS, "name"),
    cursor: pick(params, "cursor", null),
    selected: [
      ...new Set(
        (params.get("selected") || "")
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id && id.length <= MAX_VALUE),
      ),
    ].slice(0, MAX_REPORT_SITES),
  };
}

const DEFAULTS = readOverview("");
const FILTER_KEYS = /** @type {const} */ ([
  "q",
  "show",
  ...OVERVIEW_FILTERS,
  "sort",
  "cursor",
]);

/** @param {OverviewState} state @param {Period | null} period @returns {string} "" or "?…" */
export function overviewSearch(state, period) {
  const params = periodSearch(period);
  for (const key of FILTER_KEYS)
    if (state[key] !== DEFAULTS[key]) params.set(key, state[key]);
  if (state.selected.length) params.set("selected", state.selected.join(","));
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

/** A report never holds a Site the user can't see (plan §3). @param {string[]} selected @param {string[]} pageIds */
export function keptSelection(selected, pageIds) {
  const onPage = new Set(pageIds);
  return selected.filter((id) => onPage.has(id)).slice(0, MAX_REPORT_SITES);
}
