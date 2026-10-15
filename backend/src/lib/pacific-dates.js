/*
  Pacific calendar arithmetic for the backend. The legal duty ("N checks per
  day") is counted in San Francisco's local day, so every day bucket, period
  bound, and "today" on the server comes from here, never from UTC slicing.

  Day keys are `YYYY-MM-DD` strings in Pacific time. Instants are ISO-8601
  strings in UTC, the form every timestamp in the table uses.
*/

export const PACIFIC_TIME_ZONE = "America/Los_Angeles";

const DAY_MS = 86_400_000;

const DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const WALL_CLOCK_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * @param {Intl.DateTimeFormat} formatter
 * @param {Date} date
 * @returns {Record<string, number>}
 */
function numericParts(formatter, date) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== "literal") parts[type] = Number(value);
  }
  return parts;
}

/**
 * The Pacific calendar day of an instant.
 * @param {string | number | Date} instant
 * @returns {string} `YYYY-MM-DD`, or "" when the instant does not parse
 */
export function pacificDateKey(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const { year, month, day } = numericParts(DATE_PARTS, date);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Today's Pacific day key.
 * @param {Date} [now]
 * @returns {string}
 */
export function pacificToday(now = new Date()) {
  return pacificDateKey(now);
}

/** @param {number} n @returns {string} */
function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Strict `YYYY-MM-DD` check that also rejects impossible dates (2026-02-30).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDayKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * A day key as a UTC-midnight timestamp, for arithmetic only.
 * @param {string} dayKey
 * @returns {number}
 */
function dayStamp(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** @param {number} stamp UTC-midnight timestamp @returns {string} */
function stampKey(stamp) {
  return new Date(stamp).toISOString().slice(0, 10);
}

/**
 * @param {string} dayKey
 * @param {number} days may be negative
 * @returns {string}
 */
export function addDays(dayKey, days) {
  return stampKey(dayStamp(dayKey) + days * DAY_MS);
}

/**
 * @param {string} dayKey
 * @param {number} months may be negative; clamps to the first of the month
 * @returns {string} the first day of the month `months` away
 */
export function addMonthsToFirst(dayKey, months) {
  const [y, m] = dayKey.split("-").map(Number);
  return stampKey(Date.UTC(y, m - 1 + months, 1));
}

/**
 * Pacific weekday of a day key, 0 = Sunday … 6 = Saturday.
 * @param {string} dayKey
 * @returns {number}
 */
export function weekdayIndex(dayKey) {
  return new Date(dayStamp(dayKey)).getUTCDay();
}

/**
 * Every day key from `start` up to but excluding `endExclusive`.
 * @param {string} start
 * @param {string} endExclusive
 * @returns {string[]}
 */
export function dayKeysBetween(start, endExclusive) {
  const keys = [];
  for (
    let stamp = dayStamp(start);
    stamp < dayStamp(endExclusive);
    stamp += DAY_MS
  ) {
    keys.push(stampKey(stamp));
  }
  return keys;
}

/**
 * The UTC instant at which a Pacific calendar day begins. Resolves the
 * zone's offset at that moment, so DST transition days are exact.
 * @param {string} dayKey
 * @returns {string} ISO-8601 instant
 */
export function pacificDayStartIso(dayKey) {
  const wallMidnight = dayStamp(dayKey);
  // First guess: Pacific midnight is 07:00 or 08:00 UTC. Measure the real
  // offset at the guess and correct; measure once more in case the guess
  // straddled a DST change.
  let instant = wallMidnight + 8 * 3_600_000;
  for (let i = 0; i < 2; i += 1) {
    const p = numericParts(WALL_CLOCK_PARTS, new Date(instant));
    const wall = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
    );
    instant -= wall - wallMidnight;
  }
  return new Date(instant).toISOString();
}

/** @typedef {"week" | "month" | "quarter"} PeriodKind */

/**
 * @typedef {object} Period
 * @property {PeriodKind} kind
 * @property {string} start first day (inclusive)
 * @property {string} endExclusive the day after the last day
 */

/**
 * @param {unknown} value
 * @returns {value is PeriodKind}
 */
export function isPeriodKind(value) {
  return value === "week" || value === "month" || value === "quarter";
}

/**
 * The period of `kind` that contains `dayKey`. Weeks run Sunday to Saturday
 * (the US calendar the field app shows); quarters are calendar quarters.
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
  const start = `${y}-${pad(quarterMonth)}-01`;
  return { kind, start, endExclusive: addMonthsToFirst(start, 3) };
}

/**
 * The period of the same kind immediately before `period`.
 * @param {Period} period
 * @returns {Period}
 */
export function previousPeriod(period) {
  return periodContaining(period.kind, addDays(period.start, -1));
}
