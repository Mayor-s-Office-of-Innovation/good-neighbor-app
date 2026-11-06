// Site insights' activity charts. Drawn for sighted users only; the day table
// beside them carries the same counts for screen readers.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { formatDateTime } from "../../../../frontend/src/i18n/dates.js";
import { addDays } from "../../../../frontend/src/domain/reports-periods.js";
import { escapeHtml } from "../../dom.js";

/** @typedef {{ startDay: string, endDay: string }} Span endDay exclusive */
/** @typedef {{ day: string, value: number | null }} Point null: no data that day */
/** @typedef {{ start: string, value: number | null, partial: boolean }} Bucket */

/** Noon UTC is the same calendar day in Pacific time all year. @param {string} day */
const noon = (day) => `${day}T12:00:00Z`;
/** Monday is 0, as the mock's calendars start the week. @param {string} day */
const weekday = (day) => (new Date(noon(day)).getUTCDay() + 6) % 7;
/** @param {string} day */
const monthStart = (day) => `${day.slice(0, 7)}-01`;
/** @param {string} day */
const nextMonth = (day) => {
  const [y, m] = day.split("-").map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

/** Days between two day keys. @param {string} a @param {string} b */
export const daysBetween = (a, b) =>
  Math.round((Date.parse(noon(b)) - Date.parse(noon(a))) / 86_400_000);

/** Up to a month reads best by day; longer periods as weekly or monthly totals. @param {Span} span @returns {"day" | "week" | "month"} */
export function chartUnit(span) {
  const days = daysBetween(span.startDay, span.endDay);
  return days <= 31 ? "day" : days <= 100 ? "week" : "month";
}

/**
 * Totals per week (from Monday) or month, clipped to the period. A bucket
 * with no day of data is null, so it shows as no data, not zero.
 * @param {Span} span
 * @param {Point[]} points
 * @param {"week" | "month"} unit
 * @returns {Bucket[]}
 */
export function buckets(span, points, unit) {
  const byDay = new Map(points.map((p) => [p.day, p.value]));
  /** @type {Bucket[]} */
  const out = [];
  let start =
    unit === "week"
      ? addDays(span.startDay, -weekday(span.startDay))
      : monthStart(span.startDay);
  while (start < span.endDay) {
    const next = unit === "week" ? addDays(start, 7) : nextMonth(start);
    let value = /** @type {number | null} */ (null);
    let missing = false;
    const from = start < span.startDay ? span.startDay : start;
    const to = next < span.endDay ? next : span.endDay;
    for (let day = from; day < to; day = addDays(day, 1)) {
      const v = byDay.get(day);
      if (v === undefined || v === null) missing = true;
      else value = (value ?? 0) + v;
    }
    out.push({
      start: from,
      value,
      partial: value !== null && (missing || from !== start || to !== next),
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
  const max = Math.max(0, ...points.map((p) => p.value ?? 0));
  const heads = Array.from({ length: 7 }, (_, i) =>
    // 2026-11-02 is a Monday.
    formatDateTime(noon(addDays("2026-11-02", i)), { weekday: "narrow" }),
  );
  let html = "";
  for (
    let month = monthStart(span.startDay);
    month < span.endDay;
    month = nextMonth(month)
  ) {
    const cells = Array.from({ length: weekday(month) }, () => "<td></td>");
    for (let day = month; day < nextMonth(month); day = addDays(day, 1)) {
      const n = Number(day.slice(8));
      const value = byDay.get(day);
      if (day < span.startDay || day >= span.endDay) cells.push("<td></td>");
      else if (value === undefined || value === null)
        cells.push(`<td class="insights__cal-none"><span>${n}</span></td>`);
      else
        cells.push(
          `<td class="insights__cal-${level(value, max)}"><span>${n}</span>${value}</td>`,
        );
    }
    while (cells.length % 7) cells.push("<td></td>");
    const rows = [];
    for (let i = 0; i < cells.length; i += 7)
      rows.push(`<tr>${cells.slice(i, i + 7).join("")}</tr>`);
    html += `<table class="insights__cal"><caption>${escapeHtml(formatDateTime(noon(month), { month: "long", year: "numeric" }))}</caption><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>${rows.join("")}</table>`;
  }
  return `<div class="insights__cals" data-chart="${kind}">${html}</div>`;
}

/** @param {Span} span @param {Point[]} points @param {"week" | "month"} unit @param {string} kind */
function bars(span, points, unit, kind) {
  const list = buckets(span, points, unit);
  const max = Math.max(1, ...list.map((b) => b.value ?? 0));
  const months = list.map((b) =>
    formatDateTime(noon(b.start), { month: "short" }),
  );
  return `<div class="insights__bars" data-chart="${kind}">${list
    .map(
      (b) =>
        `<div class="insights__bar${b.value === null ? " insights__bar--none" : ""}"><b>${b.value ? b.value : ""}</b><span class="insights__bar-track"><i style="height:${b.value === null ? 100 : Math.round(((b.value ?? 0) / max) * 100)}%"></i></span></div>`,
    )
    .join("")}</div><div class="insights__bar-x">${list
    // Weekly bars name each month once, at its first week.
    .map(
      (_, i) =>
        `<span>${i && months[i - 1] === months[i] ? "" : escapeHtml(months[i])}</span>`,
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
