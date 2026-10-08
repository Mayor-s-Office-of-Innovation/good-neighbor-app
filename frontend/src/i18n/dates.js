/*
  Locale-aware date and time formatting. US calendar conventions (month-day
  order, 12-hour clock, Pacific time) are fixed by the options here; the month
  and weekday NAMES come from the active locale. Nothing else in the app should
  build a date string by hand or pass a locale to Intl directly.

  The one fixed-locale formatter in this module (PACIFIC_PARTS) is computation
  only: it reads the Pacific calendar date as numbers and never produces text
  a user sees.
*/
import { getLocaleTag } from "./locale.js";

export const PACIFIC = "America/Los_Angeles";

/** Pacific calendar fields of an instant, as numbers. Computation only. */
const PACIFIC_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: PACIFIC,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** @type {Map<string, Intl.DateTimeFormat>} one formatter per (tag, options) */
const formatters = new Map();

/**
 * @param {string | number | Date} value
 * @returns {Date | null}
 */
function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {string | number | Date} value
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string} "" for an unparseable value
 */
export function formatDateTime(value, options) {
  const date = toDate(value);
  if (!date) return "";
  const tag = getLocaleTag();
  /** @type {Intl.DateTimeFormatOptions} */
  const resolved = { timeZone: PACIFIC, ...options };
  // The 12-hour clock is a product decision, not a locale default: vi-VN and
  // zh-Hant would otherwise fall back to 24-hour time.
  if ((resolved.hour || resolved.timeStyle) && resolved.hour12 === undefined) {
    resolved.hour12 = true;
  }
  const cacheKey = `${tag}|${JSON.stringify(resolved)}`;
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(tag, resolved);
    formatters.set(cacheKey, formatter);
  }
  return formatter.format(date);
}

/** @param {string | number | Date} value e.g. "3:05 PM" */
export function formatTime(value) {
  return formatDateTime(value, { hour: "numeric", minute: "2-digit" });
}

/** @param {string | number | Date} value e.g. "Tuesday" */
export function formatWeekday(value) {
  return formatDateTime(value, { weekday: "long" });
}

/** @param {string | number | Date} value e.g. "Oct 2" */
export function formatMonthDay(value) {
  return formatDateTime(value, { month: "short", day: "numeric" });
}

/** @param {string | number | Date} value e.g. "10/02/26" */
export function formatNumericDate(value) {
  return formatDateTime(value, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

/** @param {string | number | Date} value e.g. "Oct 2, 3:05 PM" */
export function formatMonthDayTime(value) {
  return formatDateTime(value, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The Pacific calendar day of an instant as a UTC midnight timestamp, so day
 * arithmetic and weekday lookups need no locale-dependent text.
 * @param {Date} date
 * @returns {number}
 */
function pacificDayStamp(date) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const { type, value } of PACIFIC_PARTS.formatToParts(date)) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

/**
 * Whole days between two instants in Pacific calendar terms (0 = same day,
 * 1 = yesterday). Used to choose "today" / "yesterday" / weekday wording.
 * @param {string | number | Date} value
 * @param {Date} [now]
 * @returns {number | null}
 */
export function pacificDaysAgo(value, now = new Date()) {
  const date = toDate(value);
  if (!date) return null;
  const dayMs = 86400000;
  return Math.round((pacificDayStamp(now) - pacificDayStamp(date)) / dayMs);
}

/**
 * Pacific weekday of an instant, 0 = Sunday … 6 = Saturday.
 * @param {string | number | Date} value
 * @returns {number | null}
 */
export function pacificWeekdayIndex(value) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(pacificDayStamp(date)).getUTCDay();
}

/** Stable Pacific calendar grouping key, independent of display language. */
export function pacificDateKey(value) {
  const date = toDate(value);
  return date ? new Date(pacificDayStamp(date)).toISOString().slice(0, 10) : "";
}
