// Site insights' activity charts. Drawn for sighted users only; the day table
// beside them carries the same counts for screen readers.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import {
  formatDateTime,
  pacificDateKey,
} from "../../../../frontend/src/i18n/dates.js";
import {
  addDays,
  dayInstant,
  dayKeysBetween,
  periodContaining,
  weekdayIndex,
  weekdayInitials,
} from "../../../../frontend/src/domain/reports-periods.js";
import { escapeHtml } from "../../dom.js";

/** @typedef {{ startDay: string, endDay: string, incomplete?: boolean, observedTo?: string }} Span endDay exclusive */
/** @typedef {{ day: string, value: number | null }} Point null: no data that day */
/** @typedef {{ start: string, value: number | null, partial: boolean, future: boolean }} Bucket */

/** @param {string} day */
const nextMonth = (day) => periodContaining("month", day).endExclusive;

/**
 * The day after the last one with data. In a running period later days
 * haven't happened, so they mustn't read as missing data.
 * @param {Span} span
 */
function dataEnd(span) {
  const today = runningDay(span);
  return today === null ? span.endDay : addDays(today, 1);
}

/**
 * A running period's last day with data, still under way at the update.
 * @param {Span} span
 * @returns {string | null}
 */
function runningDay(span) {
  if (!span.incomplete || !span.observedTo) return null;
  const day = pacificDateKey(span.observedTo);
  return day < span.endDay ? day : null;
}

/** Up to a month reads best by day; longer periods as weekly or monthly totals. @param {Span} span @returns {"day" | "week" | "month"} */
export function chartUnit(span) {
  const days = dayKeysBetween(span.startDay, span.endDay).length;
  return days <= 31 ? "day" : days <= 100 ? "week" : "month";
}

/**
 * Totals per week (from Sunday) or month, clipped to the period. A bucket
 * with no day of data is null, so it shows as no data, not zero.
 * @param {Span} span
 * @param {Point[]} points
 * @param {"week" | "month"} unit
 * @returns {Bucket[]}
 */
export function buckets(span, points, unit) {
  const byDay = new Map(points.map((p) => [p.day, p.value]));
  const end = dataEnd(span);
  const today = runningDay(span);
  /** @type {Bucket[]} */
  const out = [];
  let start = periodContaining(unit, span.startDay).start;
  while (start < span.endDay) {
    const next = periodContaining(unit, start).endExclusive;
    let value = /** @type {number | null} */ (null);
    let missing = false;
    const from = start < span.startDay ? span.startDay : start;
    const to = next < end ? next : end;
    for (let day = from; day < to; day = addDays(day, 1)) {
      const v = byDay.get(day);
      if (v === undefined || v === null) missing = true;
      else value = (value ?? 0) + v;
    }
    out.push({
      start: from,
      value,
      partial:
        value !== null &&
        (missing ||
          from !== start ||
          to !== next ||
          (today !== null && today >= from && today < to)),
      future: from >= end,
    });
    start = next;
  }
  return out;
}

/** Three shades, scaled to the busiest day, so a quiet Site still shows its pattern. @param {number} value @param {number} max */
const level = (value, max) =>
  value <= 0 ? 0 : Math.min(3, Math.ceil((3 * value) / Math.max(max, 1)));

/** @param {Span} span @param {Point[]} points @param {string} kind "checks" | "issues", for colour */
function calendars(span, points, kind) {
  const byDay = new Map(points.map((p) => [p.day, p.value]));
  const today = runningDay(span);
  // A day still under way would shade every finished day lighter.
  const max = Math.max(
    0,
    ...points.map((p) => (p.day === today ? 0 : (p.value ?? 0))),
  );
  const end = dataEnd(span);
  const heads = weekdayInitials();
  const partial = escapeHtml(t("admin.insights.chart.partialDay"));
  let html = "";
  for (
    let month = periodContaining("month", span.startDay).start;
    month < span.endDay;
    month = nextMonth(month)
  ) {
    const cells = Array.from(
      { length: weekdayIndex(month) },
      () => "<td></td>",
    );
    for (let day = month; day < nextMonth(month); day = addDays(day, 1)) {
      const n = Number(day.slice(8));
      const value = byDay.get(day);
      if (day < span.startDay || day >= span.endDay) cells.push("<td></td>");
      else if (day >= end)
        cells.push(`<td data-cal="future"><span>${n}</span></td>`);
      else if (value === undefined || value === null)
        cells.push(
          `<td class="insights__cal-none" data-cal="none"><span>${n}</span></td>`,
        );
      else if (day === today)
        cells.push(
          `<td class="insights__cal-${level(value, max)} insights__cal--partial" data-cal="${value}" data-cal-partial title="${partial}"><span>${n}</span>${value}</td>`,
        );
      else
        cells.push(
          `<td class="insights__cal-${level(value, max)}" data-cal="${value}"><span>${n}</span>${value}</td>`,
        );
    }
    while (cells.length % 7) cells.push("<td></td>");
    const rows = [];
    for (let i = 0; i < cells.length; i += 7)
      rows.push(`<tr>${cells.slice(i, i + 7).join("")}</tr>`);
    html += `<table class="insights__cal"><caption>${escapeHtml(formatDateTime(dayInstant(month), { month: "long", year: "numeric" }))}</caption><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>${rows.join("")}</table>`;
  }
  return `<div class="insights__cals" data-chart="${kind}">${html}</div>`;
}

/** @param {Span} span @param {Point[]} points @param {"week" | "month"} unit @param {string} kind */
function bars(span, points, unit, kind) {
  const list = buckets(span, points, unit);
  const max = Math.max(1, ...list.map((b) => b.value ?? 0));
  const months = list.map((b) => b.start.slice(0, 7));
  // January carries its year, so a period across New Year doesn't show "Jan" twice unexplained.
  // The year takes its own line, since "Jan 2026" is wider than a month's bar.
  const monthName = (/** @type {string} */ day) =>
    `${escapeHtml(formatDateTime(dayInstant(day), { month: "short" }))}${
      day.slice(5, 7) === "01"
        ? `<span class="insights__bar-year">${escapeHtml(formatDateTime(dayInstant(day), { year: "numeric" }))}</span>`
        : ""
    }`;
  const partial = t("admin.insights.chart.partial");
  return `<div class="insights__bars" data-chart="${kind}">${list
    .map((b) => {
      if (b.future)
        return `<div class="insights__bar" data-bar="future"><b></b><span class="insights__bar-track"></span></div>`;
      const state = b.value === null ? "none" : b.partial ? "partial" : "full";
      const height = b.value === null ? 100 : Math.round((b.value / max) * 100);
      return `<div class="insights__bar${state === "full" ? "" : ` insights__bar--${state}`}" data-bar="${state}"${state === "partial" ? ` title="${escapeHtml(partial)}"` : ""}><b>${b.value ? b.value : ""}</b><span class="insights__bar-track"><i style="height:${height}%"></i></span></div>`;
    })
    .join("")}</div><div class="insights__bar-x">${list
    // Weekly bars name each month once, at its first week.
    .map(
      (b, i) =>
        `<span data-bar-label>${i && months[i - 1] === months[i] ? "" : monthName(b.start)}</span>`,
    )
    .join("")}</div>`;
}

/**
 * @param {Span} span
 * @param {Point[]} points one per covered day
 * @param {string} kind "checks" | "issues"
 */
export function activityChart(span, points, kind) {
  if (!points.some((p) => p.value !== null))
    return `<p class="muted">${escapeHtml(t("admin.insights.chart.noData"))}</p>`;
  const unit = chartUnit(span);
  return `<div aria-hidden="true">${unit === "day" ? calendars(span, points, kind) : bars(span, points, unit, kind)}</div>`;
}
