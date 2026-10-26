/*
  Presentational templates for <reports-view> and <reports-day-view>, the
  site manager's Checks report. Pure (data) → HTML string; state, fetching,
  and wiring live in reports-view.js. Every status is carried by a word or a
  count as well as a color (WCAG 1.4.1); the charts carry a visually hidden
  table as their text equivalent.
*/
import { t } from "../i18n/i18n.js";
import { formatMonthDay, formatTime } from "../i18n/dates.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import {
  attributionDialog,
  languageDialog,
  logoutDialog,
  settingsMenu,
} from "./today-view.templates.js";
import { taskAnalysisCard } from "./analysis-results.templates.js";
import {
  issueTrend,
  resolutionSummary,
  resolutionTime,
  attentionFlags,
  filterReportIssues,
  issuesByDay,
  issuesByWeek,
  issuesOfType,
  issueTypeTitle,
  lastReportedLabel,
  summarizeIssues,
  isIssue,
  resolvedInPeriod,
} from "../domain/reports-issues.js";
import {
  PERIOD_KINDS,
  addDays,
  calendarCells,
  dayKeysBetween,
  dayInstant,
  periodLabel,
  weekBuckets,
  weekdayInitials,
} from "../domain/reports-periods.js";

/** @typedef {import("../domain/reports-periods.js").Period} Period */
/** @typedef {import("../domain/reports-periods.js").DaySummary} DaySummary */

export const REPORT_TABS = [
  { id: "checks", labelKey: "reports.tab.checks" },
  { id: "issues", labelKey: "reports.tab.issues" },
];

const RECORD_PAGE = 10;
/** Types shown on the Issues tab before "View all issue types". */
export const TYPE_ROWS = 5;

/* ---- Shell ---- */

/**
 * @param {{
 *   heading: string,
 *   body: string,
 *   tab: string,
 *   settingsMenuOpen?: boolean,
 *   logoutError?: string,
 *   logoutPending?: boolean,
 * }} vm
 *   `body` is already-rendered markup for the active tab.
 */
export function reportsShell({
  heading,
  body,
  tab,
  settingsMenuOpen = false,
  logoutError = "",
  logoutPending = false,
}) {
  return html`
    <div class="home reports">
      <section class="home-region home-region--header">
        <div class="home-top-actions reports__top">
          <a
            class="reports-back"
            id="reports-home"
            href="/today"
            aria-label="${escapeAttr(t("reports.backHome"))}"
          >
            <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
          </a>
          ${settingsMenu({ open: settingsMenuOpen, adminAccess: true })}
          <feedback-dialog
            class="feedback-dialog"
            hide-trigger
          ></feedback-dialog>
        </div>
        <div class="screen screen--today-hero reports__head">
          <site-switcher></site-switcher>
          <h1 class="reports__title" tabindex="-1" data-screen-focus>
            ${escapeHtml(heading)}
          </h1>
          ${reportTabs({ activeId: tab })}
        </div>
      </section>
      <section
        class="home-region home-region--results reports__body"
        aria-live="polite"
      >
        ${body}
      </section>
      ${attributionDialog()} ${languageDialog()}
      ${logoutDialog({ error: logoutError, pending: logoutPending })}
    </div>
  `;
}

/**
 * The tab row, only when there is more than one tab to choose from.
 * @param {{ activeId: string, tabs?: Array<{ id: string, labelKey: string }> }} vm
 */
export function reportTabs({ activeId, tabs = REPORT_TABS }) {
  if (tabs.length < 2) return "";
  return html`
    <div
      class="home-tabs"
      role="group"
      aria-label="${escapeAttr(t("reports.tabs.aria"))}"
    >
      ${tabs
        .map(
          (tab) => html`
            <button
              class="home-tabs__tab ${tab.id === activeId
                ? "home-tabs__tab--active"
                : ""}"
              type="button"
              aria-pressed="${tab.id === activeId ? "true" : "false"}"
              data-report-tab="${escapeAttr(tab.id)}"
            >
              ${escapeHtml(t(tab.labelKey))}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

/**
 * Period type + period pickers and the CSV export button.
 * @param {{ kind: string, options: Period[], selectedStart: string }} vm
 */
export function periodFilters({ kind, options, selectedStart }) {
  return html`
    <div class="reports__filters">
      <wa-select
        id="reports-kind"
        size="small"
        label="${escapeAttr(t("reports.filters.kind"))}"
        value="${escapeAttr(kind)}"
        >${PERIOD_KINDS.map(
          (value) =>
            html`<wa-option value="${value}"
              >${escapeHtml(t(`reports.kind.${value}`))}</wa-option
            >`,
        ).join("")}</wa-select
      >
      <wa-select
        id="reports-period"
        size="small"
        label="${escapeAttr(t("reports.filters.period"))}"
        value="${escapeAttr(selectedStart)}"
        >${options
          .map(
            (period) =>
              html`<wa-option value="${escapeAttr(period.start)}"
                >${escapeHtml(periodLabel(period))}</wa-option
              >`,
          )
          .join("")}</wa-select
      >
      <button
        class="reports__export"
        id="reports-export"
        type="button"
        aria-label="${escapeAttr(t("reports.filters.export"))}"
        title="${escapeAttr(t("reports.filters.export"))}"
      >
        <wa-icon name="download" aria-hidden="true"></wa-icon>
      </button>
    </div>
  `;
}

/* ---- States ---- */

export function loadingBlock() {
  return html`<p class="reports__status" role="status">
    <wa-spinner aria-hidden="true"></wa-spinner>
    ${escapeHtml(t("common.loading"))}
  </p>`;
}

export function errorBlock() {
  return html`<div class="reports__status" role="alert">
    <p>${escapeHtml(t("reports.loadError"))}</p>
    <button
      class="btn-outline btn-outline--sm"
      id="reports-retry"
      type="button"
    >
      ${escapeHtml(t("common.retry"))}
    </button>
  </div>`;
}

/* ---- Checks tab ---- */

/**
 * @param {{
 *   report: { period: Period, today: string, days: DaySummary[], totals: any, tasks?: any[], previous: { totals: any }, requirement?: { requiredPerDay?: number, required?: boolean, assumed?: boolean } },
 *   filters: string,
 *   shown: number,
 * }} vm
 */
export function checksTab({ report, filters, shown }) {
  const { period, days } = report;
  const recorded = days.reduce(
    (sum, day) => sum + day.completed + (day.reports || 0),
    0,
  );
  const issues = (report.tasks || []).filter(isIssue);
  const resolved = issues.filter((task) => resolvedInPeriod(task, period));
  const href = issuesTabHref(period);
  return html`
    ${filters}
    <div class="reports__headline">
      <h2 class="reports__headline-title">
        ${escapeHtml(t("reports.checks.recorded", { count: recorded }))}
      </h2>
    </div>
    <div class="reports__card reports-counts">
      ${period.kind === "quarter"
        ? weekChart(days, report.today)
        : calendarGrid(days)}
      ${period.kind === "quarter" ? "" : legend()}
    </div>
    <div class="reports__metrics">
      ${[
        [issues.length, "found", href],
        [resolved.length, "resolved", `${href}&status=resolved`],
      ]
        .map(
          ([count, label, link]) =>
            html` <a class="reports__metric" href="${escapeAttr(link)}">
              <span
                ><strong>${count}</strong
                ><span>${escapeHtml(t(`reports.metrics.${label}`))}</span></span
              >
              <span class="reports__metric-caret"
                ><wa-icon name="chevron-right" aria-hidden="true"></wa-icon
              ></span>
            </a>`,
        )
        .join("")}
    </div>
    ${recordsList({ days, today: report.today, period, shown })}
  `;
}

/**
 * Count bands do not depend on a site's required check cadence.
 * @param {DaySummary} day
 * @returns {"complete" | "partial" | "missed" | "exempt"}
 */
export function checkCountBand(day) {
  const count = day.completed + (day.reports || 0);
  if (count >= 3) return "complete";
  if (count > 0) return "partial";
  return day.operating === false ? "exempt" : "missed";
}

/** Weekly totals of recorded checks, including unscheduled checks.
 * @param {DaySummary[]} days
 * @param {string} [today]
 */
export function weekChart(days, today = "") {
  const weeks = weekBuckets(days).map((week) => ({
    ...week,
    count: days
      .filter(
        (day) => day.date >= week.start && day.date < addDays(week.start, 7),
      )
      .reduce((sum, day) => sum + day.completed + (day.reports || 0), 0),
  }));
  const barWidth = 10;
  const gap = 0.7;
  const height = 60;
  const width = Math.max(barWidth, weeks.length * (barWidth + gap) - gap);
  const max = Math.max(1, ...weeks.map((week) => week.count));
  const bars = weeks
    .map((week, i) => {
      const h = (height * week.count) / max;
      const current = today >= week.start && today < addDays(week.start, 7);
      return html`<g
        ><title>
          ${escapeHtml(
            t("reports.checks.week", {
              date: formatMonthDay(dayInstant(week.start)),
            }),
          )}:
          ${escapeHtml(t("reports.checks.recorded", { count: week.count }))}
        </title>
        ${week.count
          ? html`<rect
              class="reports-chart__bar reports-chart__bar--${current
                ? "current"
                : "complete"}"
              x="${i * (barWidth + gap)}"
              y="${(height - h).toFixed(2)}"
              width="${barWidth}"
              height="${h.toFixed(2)}"
              rx="0.8"
            ></rect>`
          : ""}
      </g>`;
    })
    .join("");
  return html`<h3 class="reports__card-title">
      ${escapeHtml(t("reports.checks.chartTitle"))}
    </h3>
    ${chartPlot(
      bars,
      width,
      height,
      max,
      t("reports.axis.checks"),
      t("reports.checks.chartAria", { weeks: weeks.length }),
    )}
    ${chartLabelRow(monthTicks(weeks))}
    <ul class="reports-legend">
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--complete"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.checks.legend.recorded"))}
      </li>
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--current"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.checks.legend.current"))}
      </li>
    </ul>
    <table class="visually-hidden">
      <caption>
        ${escapeHtml(t("reports.checks.chartTable"))}
      </caption>
      <thead>
        <tr>
          <th scope="col">${escapeHtml(t("reports.filters.period"))}</th>
          <th scope="col">${escapeHtml(t("reports.axis.checks"))}</th>
        </tr>
      </thead>
      <tbody>
        ${weeks
          .map(
            (week) =>
              html`<tr>
                <th scope="row">
                  ${escapeHtml(
                    t("reports.checks.week", {
                      date: formatMonthDay(dayInstant(week.start)),
                    }),
                  )}
                </th>
                <td>${week.count}</td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

/**
 * Axis labels under a bar chart, outside the SVG so they scale with the
 * user's text size: one span per labelled month whose flex-grow matches the
 * bar count it covers, so the month name centers over its own bars instead
 * of hugging one bar's edge. The hidden table is the chart's text
 * equivalent, so the row is decorative.
 * @param {{ text: string, grow: number }[]} ticks one per labelled run
 */
function chartLabelRow(ticks) {
  return html`<div class="reports-chart__labels" aria-hidden="true">
    ${ticks
      .map(
        (tick) =>
          html`<span class="reports-chart__tick" style="flex-grow: ${tick.grow}"
            >${escapeHtml(tick.text)}</span
          >`,
      )
      .join("")}
  </div>`;
}

/**
 * Month ticks for the week chart: the label of a week containing the 1st
 * spans from that week through the week before the next label (or the end
 * of the chart), so each month's name sits over its bars. A leading blank
 * span covers any unlabeled run before the first label.
 * @param {{ monthLabel?: string }[]} weeks as returned by weekBuckets
 * @returns {{ text: string, grow: number }[]}
 */
function monthTicks(weeks) {
  const labeled = weeks
    .map((week, i) => ({ label: week.monthLabel || "", i }))
    .filter((entry) => entry.label);
  const head = labeled[0]?.i ? [{ text: "", grow: labeled[0].i }] : [];
  return labeled.length
    ? [
        ...head,
        ...labeled.map(({ label, i }, k) => ({
          text: label,
          grow: (labeled[k + 1]?.i ?? weeks.length) - i,
        })),
      ]
    : [{ text: "", grow: weeks.length }];
}

/**
 * The month calendar or the single week strip: a 7-column grid of day cells,
 * each carrying its count and status in text.
 * @param {DaySummary[]} days
 */
export function calendarGrid(days) {
  const cells = calendarCells(days);
  return html`
    <h3 class="reports__card-title">
      ${escapeHtml(t("reports.checks.byDay"))}
    </h3>
    <ol
      class="reports-calendar"
      aria-label="${escapeAttr(t("reports.checks.calendarAria"))}"
    >
      ${weekdayInitials()
        .map(
          (initial) =>
            html`<li class="reports-calendar__weekday" aria-hidden="true">
              ${escapeHtml(initial)}
            </li>`,
        )
        .join("")}
      ${cells
        .map((day) =>
          day
            ? dayCell(day)
            : html`<li
                class="reports-calendar__blank"
                aria-hidden="true"
              ></li>`,
        )
        .join("")}
    </ol>
  `;
}

/** @param {DaySummary} day */
function dayCell(day) {
  const count = day.completed + (day.reports || 0);
  const label = `${formatMonthDay(dayInstant(day.date))}: ${t("reports.checks.recorded", { count })}`;
  return html`<li
    class="reports-calendar__day reports-calendar__day--${checkCountBand(day)}"
    aria-label="${escapeAttr(label)}"
    title="${escapeAttr(label)}"
  >
    <span class="reports-calendar__number" aria-hidden="true"
      >${Number(day.date.slice(-2))}</span
    >
    <span class="visually-hidden">${escapeHtml(label)}</span>
  </li>`;
}

export function legend() {
  return html`<ul class="reports-legend">
    ${["complete", "partial", "missed", "exempt"]
      .map(
        (band) =>
          html` <li class="reports-legend__item">
            <span
              class="reports-legend__dot reports-legend__dot--${band}"
              aria-hidden="true"
            ></span
            >${escapeHtml(t(`reports.counts.${band}`))}
          </li>`,
      )
      .join("")}
  </ul>`;
}

/** @param {string} status */
export function statusPill(status) {
  return html`<span class="reports-pill reports-pill--${escapeAttr(status)}"
    >${escapeHtml(t(`reports.status.${status}`))}</span
  >`;
}

/**
 * @param {{ days: DaySummary[], today: string, period: Period, shown: number }} vm
 */
export function recordsList({ days, today, period, shown }) {
  const records = days
    .filter((day) => day.checkIds.length > 0)
    .slice()
    .reverse();
  const visible = records.slice(0, shown);
  return html`
    <section class="reports__records" aria-labelledby="reports-records-title">
      <h2 class="reports__records-title" id="reports-records-title">
        ${escapeHtml(
          t("reports.records.period", { period: periodLabel(period) }),
        )}
      </h2>
      ${records.length
        ? html`<ol class="reports__record-list">
            ${visible.map((day) => dayCard(day, today, period)).join("")}
          </ol>`
        : html`<p class="reports__status" role="status">
            ${escapeHtml(t("reports.records.empty"))}
          </p>`}
      ${records.length > visible.length
        ? html`<button
            class="btn-outline btn-outline--sm reports__more"
            id="reports-show-more"
            type="button"
            data-next="${visible.length + RECORD_PAGE}"
          >
            ${escapeHtml(t("reports.records.showMore"))}
          </button>`
        : ""}
    </section>
  `;
}

/** @param {DaySummary} day @param {string} today @param {Period} period */
function dayCard(day, today, period) {
  const title = formatMonthDay(dayInstant(day.date));
  const href = `/reports/checks/${day.date}?period=${period.kind}&start=${period.start}`;
  return html`<li class="reports__record" data-day="${escapeAttr(day.date)}">
    <a class="reports__record-link" href="${escapeAttr(href)}">
      <div>
        <h3 class="reports__record-title">${escapeHtml(title)}</h3>
        <ul class="reports__check-rows">
          ${(day.checks || [])
            .map(
              (check) =>
                html` <li>
                  <strong>${escapeHtml(formatTime(check.startedAt))}</strong
                  ><span
                    >${escapeHtml(
                      [
                        t("reports.check.photos", { count: check.photoCount }),
                        t("reports.check.issueCount", {
                          count: check.issueCount || 0,
                        }),
                        t("reports.check.resolvedCount", {
                          count: check.resolvedCount || 0,
                        }),
                      ].join(" · "),
                    )}</span
                  >
                </li>`,
            )
            .join("")}
        </ul>
      </div>
      <wa-icon name="chevron-right" aria-hidden="true"></wa-icon>
    </a>
  </li>`;
}

/* ---- Day detail ---- */

/**
 * @typedef {object} CheckDetail
 * @property {any} check CHECK# header
 * @property {Array<{ artifactId: string, url?: string, thumbnailUrl?: string, kind: "photo" | "text" }>} evidence
 *   `url` is the original (lightbox); `thumbnailUrl` the card variant when stored
 * @property {any[]} tasks tasks created from this check
 */

/**
 * @param {{ day: DaySummary, today: string, checks: CheckDetail[], siteName?: string }} vm
 */
export function dayDetail({ day, checks, siteName = "" }) {
  return html`
    <div class="flow reports reports-day">
      <header class="topbar">
        <a
          class="topbar__back reports-day__back"
          href="/reports"
          aria-label="${escapeAttr(t("reports.day.back"))}"
        >
          <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
        </a>
        <div class="topbar__titles">
          <h1
            class="topbar__title reports-day__title"
            tabindex="-1"
            data-screen-focus
          >
            ${escapeHtml(formatMonthDay(dayInstant(day.date)))}
          </h1>
          <p class="topbar__sub">
            ${escapeHtml(
              t("reports.checks.recorded", { count: checks.length }),
            )}
            ·
            ${escapeHtml(
              t("reports.day.issues", {
                count: checks.reduce(
                  (sum, detail) => sum + detail.tasks.length,
                  0,
                ),
              }),
            )}
          </p>
        </div>
      </header>
      <ol
        class="reports-timeline"
        aria-label="${escapeAttr(t("reports.day.timelineAria"))}"
      >
        ${checks.map((detail) => checkTimelineItem(detail, siteName)).join("")}
      </ol>
    </div>
  `;
}

/** @param {CheckDetail} detail @param {string} siteName */
function checkTimelineItem({ check, evidence, tasks }, siteName) {
  const when = check.startedAt || check.completedAt || "";
  const photos = evidence.filter((e) => e.kind === "photo");
  const meta = [
    photos.length
      ? t("reports.check.photos", { count: photos.length })
      : t("reports.check.description"),
    t("reports.day.issues", { count: tasks.length }),
  ].join(" · ");
  return html`<li class="reports-timeline__item reports-timeline__item--done">
    <h2 class="reports-timeline__time">
      <span class="visually-hidden"
        >${escapeHtml(t("reports.check.completed"))}</span
      >
      ${escapeHtml(formatTime(when))}
    </h2>
    <p class="reports-timeline__meta">${escapeHtml(meta)}</p>
    ${photos.length
      ? html`<ul class="reports-timeline__photos">
          ${photos
            .map(
              (photo, i) =>
                html`<li>
                  ${photo.url
                    ? html`<button
                        type="button"
                        class="reports-timeline__photo"
                        data-photo-lightbox
                        data-full-src="${escapeAttr(photo.url)}"
                        data-photo-time="${escapeAttr(when)}"
                      >
                        <img
                          src="${escapeAttr(photo.thumbnailUrl || photo.url)}"
                          alt="${escapeAttr(
                            t("reports.check.photoAlt", { index: i + 1 }),
                          )}"
                          loading="lazy"
                        />
                      </button>`
                    : html`<span
                        class="reports-timeline__photo reports-timeline__photo--placeholder"
                        aria-hidden="true"
                        ><wa-icon name="image"></wa-icon
                      ></span>`}
                </li>`,
            )
            .join("")}
        </ul>`
      : ""}
    ${tasks.length
      ? html`<h3 class="reports-timeline__issues">
            ${escapeHtml(t("reports.day.issues", { count: tasks.length }))}
          </h3>
          <ul class="reports-timeline__tasks">
            ${tasks
              .map((task) => html`<li>${reportTaskCard(task, siteName)}</li>`)
              .join("")}
          </ul>`
      : ""}
  </li>`;
}

/**
 * The shared home task card, with an informational timeline action and
 * no edit, delete, or resolution controls, including for filed 311 tasks.
 * @param {any} task hydrated by the day view (evidence, media, 311 status)
 * @param {string} siteName
 */
export function reportTaskCard(task, siteName) {
  return taskAnalysisCard({
    task,
    siteName,
    isNew: false,
    includeControls: false,
    readOnly: true,
    statusLabel: "",
    action: {
      kind: "update",
      label: t("reports.viewTimeline"),
      variant: "outline",
    },
  });
}

export function dayNotFound() {
  return html`<div class="flow reports reports-day">
    <header class="topbar">
      <a
        class="topbar__back reports-day__back"
        href="/reports"
        aria-label="${escapeAttr(t("reports.day.back"))}"
      >
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </a>
      <div class="topbar__titles">
        <h1 class="topbar__title" tabindex="-1" data-screen-focus>
          ${escapeHtml(t("reports.title"))}
        </h1>
      </div>
    </header>
    <p class="reports__status" role="status">
      ${escapeHtml(t("reports.day.notFound"))}
    </p>
  </div>`;
}

/* ---- Issues tab (draft: the Issues and Actions designs combined) ---- */

/**
 * @param {{
 *   report: { period: Period, today: string, tasks: any[], previous: { count: number } },
 *   filters: string,
 *   shown: number,
 *   shownTypes?: number,
 *   resolvedOnly?: boolean,
 *   filter?: string,
 *   siteName?: string,
 * }} vm shownTypes: how many type rows before "View all" (default TYPE_ROWS)
 */
export function issuesTab({
  report,
  filters,
  shown,
  shownTypes = TYPE_ROWS,
  resolvedOnly = false,
  filter = "",
  siteName = "",
}) {
  const { period, tasks, previous } = report;
  const summary = summarizeIssues(tasks || []);

  const selected = filter || (resolvedOnly ? "resolved" : "");
  const rows = filterReportIssues(
    (tasks || [])
      .filter(isIssue)
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    report,
    selected,
  );
  const visible = rows.slice(0, shown);
  return html`
    ${filters}
    ${summary.total
      ? html`<div class="reports__headline">
          <h2 class="reports__headline-title">
            ${escapeHtml(
              t("reports.issues.headline", { count: summary.total }),
            )}
          </h2>
          <p class="reports__headline-sub">
            ${escapeHtml(
              issueTrend(summary.total, previous.count, period.kind),
            )}
          </p>
        </div>`
      : html`<p class="reports__status" role="status">
          ${escapeHtml(
            t(
              resolvedOnly
                ? "reports.issues.resolvedEmpty"
                : "reports.issues.none",
            ),
          )}
          ${resolvedOnly
            ? ""
            : escapeHtml(issueTrend(0, previous.count, period.kind))}
        </p>`}
    ${!summary.total
      ? medianResolutionMetric(resolutionSummary([], period))
      : ""}
    ${summary.total
      ? html`<div class="reports__card">
            ${dailyIssuesChart(tasks || [], period)}
          </div>
          ${medianResolutionMetric(
            resolutionSummary((tasks || []).filter(isIssue), period),
          )}
          <section class="reports-types-section">
            <h2 class="reports-types-section__title">
              ${escapeHtml(t("reports.issues.types.title"))}
            </h2>
            <ul class="reports-types">
              ${summary.byCategory
                .slice(0, shownTypes)
                .map((entry) => typeRow(entry, period, false, tasks))
                .join("")}
            </ul>
            ${summary.byCategory.length > shownTypes
              ? html`<button
                  class="btn-outline btn-outline--sm reports-types__all"
                  id="reports-types-all"
                  type="button"
                >
                  ${escapeHtml(t("reports.issues.types.viewAll"))}
                </button>`
              : ""}
          </section> `
      : ""}
    ${summary.total
      ? html`<section
          class="reports__records"
          aria-labelledby="reports-issues-title"
        >
          <header class="reports__records-heading">
            <h2 class="reports__records-title" id="reports-issues-title">
              ${escapeHtml(
                t("reports.issues.periodTitle", {
                  period: periodLabel(period),
                }),
              )}
            </h2>
            <p class="reports__records-sub" role="status">
              ${escapeHtml(
                t("reports.issues.byType.count", { count: rows.length }),
              )}
            </p>
          </header>
          ${resolutionFilters(
            resolutionSummary((tasks || []).filter(isIssue), period),
            selected,
          )}
          ${selected
            ? html`<p class="reports__filter-note">
                <button
                  class="btn-outline btn-outline--sm"
                  type="button"
                  data-issue-filter=""
                  id="reports-clear-filter"
                >
                  ${escapeHtml(t("reports.issues.showAll"))}
                </button>
              </p>`
            : ""}
          ${rows.length
            ? html`<ol class="reports-type__cards">
                ${visible
                  .map(
                    (task) => html`<li>${reportTaskCard(task, siteName)}</li>`,
                  )
                  .join("")}
              </ol>`
            : ""}
          ${rows.length > visible.length
            ? html`<button
                class="btn-outline btn-outline--sm reports__more"
                id="reports-show-more"
                type="button"
                data-next="${visible.length + RECORD_PAGE}"
              >
                ${escapeHtml(t("reports.records.showMore"))}
              </button>`
            : ""}
        </section>`
      : ""}
  `;
}

/**
 * @param {string} key issue type key
 * @param {Period} period
 */
export function typeHref(key, period) {
  return `/reports/issues/${encodeURIComponent(key)}?period=${period.kind}&start=${period.start}`;
}

/** @param {Period} period */
function issuesTabHref(period) {
  return `/reports?tab=issues&period=${period.kind}&start=${period.start}`;
}

/**
 * One "Recurring issue types" row: the whole row links to the type screen.
 * @param {{ key: string, category: string, count: number, lastReportedAt: string }} entry
 * @param {Period} period
 */
function typeRow(entry, period, resolvedOnly = false, tasks = []) {
  const summary = resolutionSummary(issuesOfType(tasks, entry.key), period);
  return html`<li class="reports-types__item">
    <a
      class="reports-types__link"
      href="${escapeAttr(
        typeHref(entry.key, period) + (resolvedOnly ? "&status=resolved" : ""),
      )}"
    >
      <span class="reports-types__copy">
        <span class="reports-types__name">
          ${escapeHtml(entry.category)}
          <span class="reports-types__count"
            >${escapeHtml(
              t("reports.issues.byType.count", { count: entry.count }),
            )}</span
          >
        </span>
        <span class="reports-types__meta"
          >${escapeHtml(
            t("reports.issues.typeStatus", {
              open: summary.unresolved,
              resolved: summary.resolved,
            }),
          )}</span
        >
        <span class="reports-types__meta"
          >${escapeHtml(
            t("reports.issues.medianLine", {
              duration: resolutionTime(summary.median),
            }),
          )}</span
        >
        ${entry.lastReportedAt
          ? html`<span class="reports-types__meta"
              >${escapeHtml(lastReportedLabel(entry.lastReportedAt))}</span
            >`
          : ""}
      </span>
      <wa-icon name="chevron-right" aria-hidden="true"></wa-icon>
    </a>
  </li>`;
}

/* ---- Type screen: one issue type's reports in the period ---- */

/**
 * @param {{
 *   report: { period: Period, today: string, tasks: any[], previous: { count: number, byType?: Record<string, number> }, ticketStatusUnavailable?: boolean },
 *   key: string,
 *   shown: number,
 *   siteName?: string,
 *   resolvedOnly?: boolean,
 *   filters?: string,
 *   filter?: string,
 * }} vm tasks already hydrated by the view (evidence, media, 311 status)
 */
export function typeScreen({
  report,
  key,
  shown,
  siteName = "",
  resolvedOnly = false,
  filters = "",
  filter = "",
}) {
  const { period } = report;
  const tasks = issuesOfType(report.tasks || [], key);
  const title = issueTypeTitle(tasks, key);
  const summary = resolutionSummary(tasks, period);
  const selected = filter || (resolvedOnly ? "resolved" : "");
  const filtered = filterReportIssues(tasks, report, selected);
  const visible = filtered.slice(0, shown);
  const headline = t("reports.type.headline", {
    count: tasks.length,
    period: periodLabel(period),
  });
  return html`<div class="flow reports reports-day reports-type">
    <header class="reports-type__header">
      <a
        class="topbar__back reports-day__back"
        href="${escapeAttr(issuesTabHref(period))}"
        aria-label="${escapeAttr(t("reports.type.back"))}"
        ><wa-icon name="chevron-left" aria-hidden="true"></wa-icon
      ></a>
      <h1 class="topbar__title" tabindex="-1" data-screen-focus>
        ${escapeHtml(title)}
      </h1>
    </header>
    ${filters}
    <div>
      <p class="reports-type__headline">${escapeHtml(headline)}</p>
      <p class="reports__headline-sub">
        ${escapeHtml(
          issueTrend(
            tasks.length,
            report.previous?.byType?.[key] || 0,
            period.kind,
          ),
        )}
      </p>
    </div>
    <div class="reports__card">
      ${dailyIssuesChart(tasks, period, {
        title: t("reports.type.chartTitle", { type: title }),
        level: "h2",
      })}
    </div>
    ${medianResolutionMetric(summary)}
    <section
      class="reports-type__attention"
      aria-labelledby="reports-attention-title"
    >
      <h2 class="reports__records-title" id="reports-attention-title">
        ${escapeHtml(t("reports.issues.attention"))}
      </h2>
      ${["aged", "awaiting", "noAction"]
        .map((name) =>
          reportMetric(
            name,
            tasks.filter((task) => attentionFlags(task, report)[name]).length,
            selected,
          ),
        )
        .join("")}
      ${report.ticketStatusUnavailable
        ? html`<p role="status">
            ${escapeHtml(t("reports.issues.ticketUnavailable"))}
          </p>`
        : ""}
    </section>
    <section class="reports__records" aria-labelledby="reports-type-title">
      <header class="reports__records-heading">
        <h2 class="reports__records-title" id="reports-type-title">
          ${escapeHtml(
            t("reports.type.periodTitle", {
              type: title,
              period: periodLabel(period),
            }),
          )}
        </h2>
        <p class="reports__records-sub" role="status">
          ${escapeHtml(
            t("reports.issues.byType.count", { count: filtered.length }),
          )}
        </p>
      </header>
      ${resolutionFilters(summary, selected)}
      ${selected
        ? html`<p class="reports__filter-note">
            ${["unresolved", "resolved"].includes(selected)
              ? ""
              : escapeHtml(
                  t("reports.issues.metric." + selected, {
                    count: filtered.length,
                  }),
                )}
            <button
              type="button"
              class="btn-outline btn-outline--sm"
              data-issue-filter=""
              id="reports-clear-filter"
            >
              ${escapeHtml(t("reports.issues.showAll"))}
            </button>
          </p>`
        : ""}
      <ol class="reports-type__cards">
        ${visible
          .map((task) => html`<li>${reportTaskCard(task, siteName)}</li>`)
          .join("")}
      </ol>
      ${filtered.length > visible.length
        ? html`<button
            class="btn-outline btn-outline--sm reports__more"
            id="reports-show-more"
            type="button"
            data-next="${visible.length + RECORD_PAGE}"
          >
            ${escapeHtml(t("reports.records.showMore"))}
          </button>`
        : ""}
    </section>
  </div>`;
}

/** @param {string} name @param {number} count @param {string} selected */
function reportMetric(name, count, selected) {
  return html`<button
    type="button"
    class="btn-outline reports__metric"
    id="reports-metric-${name}"
    data-issue-filter="${name}"
    aria-pressed="${selected === name}"
  >
    <span
      ><strong>${count}</strong
      ><span
        >${escapeHtml(t("reports.issues.metric." + name, { count }))}</span
      ></span
    ><span class="reports__metric-caret"
      ><wa-icon name="chevron-right" aria-hidden="true"></wa-icon
    ></span>
  </button>`;
}

/** @param {string} backHref */
export function typeNotFound(backHref) {
  return html`<div class="flow reports reports-day">
    <header class="topbar">
      <a
        class="topbar__back reports-day__back"
        href="${escapeAttr(backHref)}"
        aria-label="${escapeAttr(t("reports.type.back"))}"
      >
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </a>
      <div class="topbar__titles">
        <h1 class="topbar__title" tabindex="-1" data-screen-focus>
          ${escapeHtml(t("reports.title"))}
        </h1>
      </div>
    </header>
    <p class="reports__status" role="status">
      ${escapeHtml(t("reports.type.notFound"))}
    </p>
  </div>`;
}

/**
 * The issues tab's bar chart: daily bars for week and month periods, weekly
 * bars for quarter, where ~92 day bars would collapse to hairlines.
 * @param {any[]} tasks
 * @param {Period} period
 */
/**
 * @param {any[]} tasks
 * @param {Period} period
 * @param {ChartHeading} [heading] override the chart's own title
 */
function dailyIssuesChart(tasks, period, heading) {
  const days = issuesByDay(
    tasks,
    dayKeysBetween(period.start, period.endExclusive),
    period,
  );
  return period.kind === "quarter"
    ? issuesWeekChart(issuesByWeek(days), heading)
    : issuesChart(days, heading);
}

/**
 * @typedef {{ title: string, level?: "h2" | "h3" }} ChartHeading
 */

/** @param {ChartHeading} heading */
function chartHeading({ title, level = "h3" }) {
  return level === "h2"
    ? html`<h2 class="reports__card-title">${escapeHtml(title)}</h2>`
    : html`<h3 class="reports__card-title">${escapeHtml(title)}</h3>`;
}

/**
 * Weekly bars for the quarter issues view: one two-tone bar per Sunday-start
 * week (the same buckets as the checks quarter chart), with the responded
 * share drawn over the found bar in green. Week tooltips ride in a
 * <g><title>, the month ticks span the weeks they start (monthTicks), and a
 * visually hidden per-week table is the text equivalent.
 * @param {Array<{ start: string, found: number, responded: number, monthLabel?: string }>} weeks
 *   from issuesByWeek, ascending
 */
export function issuesWeekChart(
  weeks,
  heading = { title: t("reports.issues.weekChartTitle") },
) {
  const barWidth = 10;
  const gap = 3;
  const height = 60;
  const max = Math.max(1, ...weeks.map((week) => week.found));
  const width = Math.max(barWidth, weeks.length * (barWidth + gap) - gap);
  const bars = weeks
    .map((week, i) => {
      const x = i * (barWidth + gap);
      const foundH = (height * week.found) / max;
      const respondedH = (height * week.responded) / max;
      return html`<g>
        <title>
          ${escapeHtml(
            t("reports.checks.week", {
              date: formatMonthDay(dayInstant(week.start)),
            }),
          )}
        </title>
        <rect
          class="reports-chart__bar reports-chart__bar--found"
          x="${x}"
          y="${(height - foundH).toFixed(2)}"
          width="${barWidth}"
          height="${foundH.toFixed(2)}"
        ></rect>
        <rect
          class="reports-chart__bar reports-chart__bar--responded"
          x="${x}"
          y="${(height - respondedH).toFixed(2)}"
          width="${barWidth}"
          height="${respondedH.toFixed(2)}"
        ></rect>
      </g>`;
    })
    .join("");
  return html`
    ${chartHeading(heading)}
    ${chartPlot(
      bars,
      width,
      height,
      max,
      t("reports.axis.issues"),
      t("reports.issues.weekChartAria", { weeks: weeks.length }),
    )}
    ${chartLabelRow(monthTicks(weeks))}
    <ul class="reports-legend reports-legend--issues">
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--found"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.legend.unresolved"))}
      </li>
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--responded"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.legend.resolved"))}
      </li>
    </ul>
    <table class="visually-hidden">
      <caption>
        ${escapeHtml(t("reports.issues.weekChartTable"))}
      </caption>
      <thead>
        <tr>
          <th scope="col">${escapeHtml(t("reports.filters.period"))}</th>
          <th scope="col">
            ${escapeHtml(t("reports.issues.chart.unresolved"))}
          </th>
          <th scope="col">${escapeHtml(t("reports.metrics.resolved"))}</th>
        </tr>
      </thead>
      <tbody>
        ${weeks
          .filter((week) => week.found)
          .map(
            (week) =>
              html`<tr>
                <th scope="row">
                  ${escapeHtml(
                    t("reports.checks.week", {
                      date: formatMonthDay(dayInstant(week.start)),
                    }),
                  )}
                </th>
                <td>${week.found - week.responded}</td>
                <td>${week.responded}</td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

/**
 * Daily bars: issues found, with the responded share filled.
 * @param {Array<{ date: string, found: number, responded: number }>} days
 */
export function issuesChart(
  days,
  heading = { title: t("reports.issues.chartTitle") },
) {
  const barWidth = 6;
  const gap = 2;
  const height = 50;
  const max = Math.max(1, ...days.map((d) => d.found));
  const width = Math.max(barWidth, days.length * (barWidth + gap) - gap);
  const labels = days.map((day, i) =>
    i === 0 || day.date.endsWith("-01") || weekdayIndexOf(day.date) === 0
      ? String(Number(day.date.slice(-2)))
      : "",
  );
  const bars = days
    .map((day, i) => {
      const x = i * (barWidth + gap);
      const foundH = (height * day.found) / max;
      const respondedH = (height * day.responded) / max;
      // Same hover contract as the other charts: each day's bars share one
      // <g><title> naming the date; the hidden table is the text equivalent.
      return html`<g>
        <title>${escapeHtml(formatMonthDay(dayInstant(day.date)))}</title>
        <rect
          class="reports-chart__bar reports-chart__bar--found"
          x="${x}"
          y="${(height - foundH).toFixed(2)}"
          width="${barWidth}"
          height="${foundH.toFixed(2)}"
        ></rect>
        <rect
          class="reports-chart__bar reports-chart__bar--responded"
          x="${x}"
          y="${(height - respondedH).toFixed(2)}"
          width="${barWidth}"
          height="${respondedH.toFixed(2)}"
        ></rect>
      </g>`;
    })
    .join("");
  return html`
    ${chartHeading(heading)}
    ${chartPlot(
      bars,
      width,
      height,
      max,
      t("reports.axis.issues"),
      t("reports.issues.chartAria", { days: days.length }),
    )}
    ${chartLabelRow(labels.map((text) => ({ text, grow: 1 })))}
    <ul class="reports-legend reports-legend--issues">
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--found"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.legend.unresolved"))}
      </li>
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--responded"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.legend.resolved"))}
      </li>
    </ul>
    <table class="visually-hidden">
      <caption>
        ${escapeHtml(t("reports.issues.chartTable"))}
      </caption>
      <thead>
        <tr>
          <th scope="col">${escapeHtml(t("reports.filters.period"))}</th>
          <th scope="col">
            ${escapeHtml(t("reports.issues.chart.unresolved"))}
          </th>
          <th scope="col">${escapeHtml(t("reports.metrics.resolved"))}</th>
        </tr>
      </thead>
      <tbody>
        ${days
          .filter((day) => day.found)
          .map(
            (day) =>
              html`<tr>
                <th scope="row">
                  ${escapeHtml(formatMonthDay(dayInstant(day.date)))}
                </th>
                <td>${day.found - day.responded}</td>
                <td>${day.responded}</td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

/** 0 = Sunday. @param {string} dayKey */
function weekdayIndexOf(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** @param {ReturnType<typeof resolutionSummary>} summary @param {string} selected */
function resolutionFilters(summary, selected) {
  return html`<div class="reports__issue-filters">
    ${["unresolved", "resolved"]
      .map(
        (name) =>
          html`<button
            type="button"
            class="btn-outline btn-outline--sm"
            id="reports-metric-${name}"
            data-issue-filter="${name}"
            aria-pressed="${selected === name}"
          >
            ${escapeHtml(
              t("reports.issues.filter." + name, { count: summary[name] }),
            )}
          </button>`,
      )
      .join("")}
  </div>`;
}

/** @param {ReturnType<typeof resolutionSummary>} summary */
function medianResolutionMetric(summary) {
  return html`<div class="reports__metric reports-type__median">
    <span
      ><strong>${escapeHtml(resolutionTime(summary.median))}</strong>
      <span>${escapeHtml(t("reports.issues.median"))}</span></span
    >
  </div>`;
}

/** Shared integer count axis for every bar chart.
 * @param {string} bars
 * @param {number} width
 * @param {number} height
 * @param {number} max
 * @param {string} unit
 * @param {string} label
 */
function chartPlot(bars, width, height, max, unit, label) {
  const ticks = [
    ...new Set([0, ...[1, 2, 3, 4].map((n) => Math.ceil((max * n) / 4))]),
  ];
  return html`<div class="reports-chart__unit">${escapeHtml(unit)}</div>
    <div class="reports-chart__plot">
      <div class="reports-chart__scale" aria-hidden="true">
        ${ticks
          .map(
            (value) =>
              html`<span style="bottom: ${(value / max) * 100}%"
                >${value}</span
              >`,
          )
          .join("")}
      </div>
      <svg
        class="reports-chart"
        preserveAspectRatio="none"
        viewBox="0 0 ${width} ${height}"
        role="img"
        aria-label="${escapeAttr(label)}"
      >
        ${ticks
          .map(
            (value) =>
              html`<line
                class="reports-chart__grid"
                x1="0"
                x2="${width}"
                y1="${height - (value / max) * height}"
                y2="${height - (value / max) * height}"
                vector-effect="non-scaling-stroke"
              ></line>`,
          )
          .join("")}
        ${bars}
      </svg>
    </div>`;
}
