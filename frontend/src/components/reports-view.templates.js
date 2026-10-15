/*
  Presentational templates for <reports-view> and <reports-day-view>, the
  site manager's Checks report. Pure (data) → HTML string; state, fetching,
  and wiring live in reports-view.js. Every status is carried by a word or a
  count as well as a color (WCAG 1.4.1); the charts carry a visually hidden
  table as their text equivalent.
*/
import { t } from "../i18n/i18n.js";
import {
  formatMonthDay,
  formatMonthDayTime,
  formatTime,
} from "../i18n/dates.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import {
  attributionDialog,
  languageDialog,
  logoutDialog,
  settingsMenu,
} from "./today-view.templates.js";
import { taskAnalysisCard } from "./analysis-results.templates.js";
import { submitted311Ticket } from "../domain/home-tasks.js";
import {
  RESPONSE_KINDS,
  issueRows,
  issuesByDay,
  issuesByWeek,
  issuesOfType,
  issueTypeTitle,
  lastReportedLabel,
  summarizeIssues,
} from "../domain/reports-issues.js";
import {
  PERIOD_KINDS,
  calendarCells,
  dayKeysBetween,
  hasRecordedChecks,
  isRecordDay,
  countDeltaLine,
  dayInstant,
  dayTitle,
  periodEnd,
  periodLabel,
  rateDeltaLine,
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
 *   report: { period: Period, today: string, days: DaySummary[], totals: any, previous: { totals: any }, requirement?: { requiredPerDay?: number, required?: boolean, assumed?: boolean } },
 *   filters: string,
 *   shown: number,
 * }} vm
 */
export function checksTab({ report, filters, shown }) {
  const { period, days, totals, previous } = report;
  const kind = period.kind;
  // Counts only compare like with like: a period still in progress is shown
  // against its own elapsed days, not against a finished previous period.
  const periodOver = periodEnd(period) < report.today;
  const elapsed = days.filter((day) => day.date <= report.today).length;
  const elapsedLine = t("reports.totals.inProgress", {
    elapsed,
    total: days.length,
  });
  return html`
    ${filters}
    ${totals.possible > 0 || totals.recorded > 0
      ? html`<div class="reports__headline">
          <h2 class="reports__headline-title">
            ${escapeHtml(
              totals.possible > 0
                ? t("reports.checks.headline", {
                    completed: totals.completed,
                    possible: totals.possible,
                  })
                : t("reports.totals.completed", { count: totals.recorded }),
            )}
          </h2>
          <p class="reports__headline-sub">
            ${escapeHtml(
              totals.possible > 0
                ? rateDeltaLine(totals, previous.totals, kind)
                : t("reports.checks.noRequirement"),
            )}
          </p>
          ${report.requirement?.assumed
            ? html`<p class="reports__headline-sub reports__headline-note">
                ${escapeHtml(t("reports.checks.assumedCadence"))}
              </p>`
            : ""}
        </div>`
      : html`<p class="reports__status" role="status">
          ${escapeHtml(t("reports.checks.noRequirement"))}
        </p>`}
    <div class="reports__card">
      ${kind === "quarter" ? weekChart(days) : calendarGrid(days)}
      ${legend({
        recorded: days.some(
          (day) => day.status === "exempt" && hasRecordedChecks(day),
        ),
      })}
    </div>
    <div class="reports__card reports__totals">
      <p class="reports__total">
        <strong
          >${escapeHtml(
            t("reports.totals.completed", { count: totals.recorded }),
          )}</strong
        >
        <span
          >${escapeHtml(
            periodOver
              ? countDeltaLine(
                  totals.completed,
                  previous.totals.completed,
                  kind,
                )
              : elapsedLine,
          )}</span
        >
      </p>
      ${totals.possible > 0
        ? html`<p class="reports__total">
            <strong
              >${escapeHtml(
                t("reports.totals.missed", { count: totals.missed }),
              )}</strong
            >
            ${periodOver
              ? html`<span
                  >${escapeHtml(
                    countDeltaLine(totals.missed, previous.totals.missed, kind),
                  )}</span
                >`
              : ""}
          </p>`
        : ""}
    </div>
    ${recordsList({ days, today: report.today, period, shown })}
  `;
}

/**
 * Stacked bars, one per Sunday-start week: days by status.
 * @param {DaySummary[]} days
 */
export function weekChart(days) {
  const weeks = weekBuckets(days);
  const barWidth = 10;
  const gap = 3;
  const height = 60;
  const width = weeks.length * (barWidth + gap) - gap;
  const segments = /** @type {const} */ ([
    ["missed", "missed"],
    ["partial", "partial"],
    ["complete", "complete"],
    ["recorded", "recorded"],
    ["open", "open"],
  ]);
  const bars = weeks
    .map((week, i) => {
      const x = i * (barWidth + gap);
      const total =
        week.complete + week.partial + week.missed + week.recorded + week.open;
      let y = height;
      const rects = segments
        .map(([field, cls]) => {
          const count = week[field];
          if (!count) return "";
          // Each bar fills its own height: a partial first or last week of
          // the period is shown by its share of days, not shrunk.
          const h = (height * count) / total;
          y -= h;
          return html`<rect
            class="reports-chart__bar reports-chart__bar--${cls}"
            x="${x}"
            y="${y.toFixed(2)}"
            width="${barWidth}"
            height="${h.toFixed(2)}"
          ></rect>`;
        })
        .join("");
      // Native SVG tooltip: grouping the week's segments under one <g>
      // <title> (first child) pairs the whole bar with its week on hover;
      // keyboard/touch users read the same data in the hidden table below.
      return html`<g>
        <title>
          ${escapeHtml(
            t("reports.checks.week", {
              date: formatMonthDay(dayInstant(week.start)),
            }),
          )}
        </title>
        ${rects}
      </g>`;
    })
    .join("");
  return html`
    <h3 class="reports__card-title">
      ${escapeHtml(t("reports.checks.chartTitle"))}
    </h3>
    <svg
      class="reports-chart"
      viewBox="0 0 ${Math.max(width, barWidth)} ${height}"
      role="img"
      aria-label="${escapeAttr(
        t("reports.checks.chartAria", { weeks: weeks.length }),
      )}"
    >
      ${bars}
    </svg>
    ${chartLabelRow(monthTicks(weeks))}
    <table class="visually-hidden">
      <caption>
        ${escapeHtml(t("reports.checks.chartTable"))}
      </caption>
      <thead>
        <tr>
          <th scope="col">${escapeHtml(t("reports.filters.period"))}</th>
          <th scope="col">${escapeHtml(t("reports.legend.complete"))}</th>
          <th scope="col">${escapeHtml(t("reports.legend.partial"))}</th>
          <th scope="col">${escapeHtml(t("reports.legend.missed"))}</th>
          <th scope="col">${escapeHtml(t("reports.legend.recorded"))}</th>
          <th scope="col">${escapeHtml(t("reports.legend.open"))}</th>
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
                <td>${week.complete}</td>
                <td>${week.partial}</td>
                <td>${week.missed}</td>
                <td>${week.recorded}</td>
                <td>${week.open}</td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  `;
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
  const owed = day.required > 0 && day.status !== "upcoming";
  const recorded = day.required === 0 && hasRecordedChecks(day);
  const label = t("reports.checks.dayCell", {
    date: formatMonthDay(dayInstant(day.date)),
    completed: day.completed,
    required: day.required,
    status: t(`reports.status.${day.status}`),
  });
  const number = Number(day.date.slice(-2));
  return html`<li
    class="reports-calendar__day reports-calendar__day--${escapeAttr(
      day.status,
    )}"
    aria-label="${escapeAttr(label)}"
  >
    <span class="reports-calendar__number" aria-hidden="true">${number}</span>
    ${owed
      ? html`<span class="reports-calendar__count" aria-hidden="true"
          >${day.completed}/${day.required}</span
        >`
      : recorded
        ? html`<span class="reports-calendar__count" aria-hidden="true"
            >${day.completed + (day.reports ?? 0)}</span
          >`
        : ""}
  </li>`;
}

/**
 * "N checks completed" for a day that owed nothing, or "N issue reports
 * recorded" when only single-issue reports were made.
 * @param {DaySummary} day
 */
function recordedLine(day) {
  return day.completed > 0
    ? t("reports.totals.completed", { count: day.completed })
    : t("reports.day.reportsOnly", { count: day.reports ?? 0 });
}

/** @param {{ recorded?: boolean }} [vm] show the "recorded, none required" entry */
export function legend({ recorded = false } = {}) {
  const entries = recorded
    ? ["complete", "partial", "missed", "recorded", "open"]
    : ["complete", "partial", "missed", "open"];
  return html`<ul class="reports-legend">
    ${entries
      .map(
        (status) =>
          html`<li class="reports-legend__item">
            <span
              class="reports-legend__dot reports-legend__dot--${status}"
              aria-hidden="true"
            ></span>
            ${escapeHtml(t(`reports.legend.${status}`))}
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
  const records = days.filter((day) => isRecordDay(day)).reverse();
  const visible = records.slice(0, shown);
  return html`
    <section class="reports__records" aria-labelledby="reports-records-title">
      <h2 class="reports__records-title" id="reports-records-title">
        ${escapeHtml(t("reports.records.title"))}
      </h2>
      <p class="reports__records-sub">${escapeHtml(periodLabel(period))}</p>
      ${records.length
        ? html`<ol class="reports__record-list">
            ${visible.map((day) => dayCard(day, today)).join("")}
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

/** @param {DaySummary} day @param {string} today */
function dayCard(day, today) {
  const title = dayTitle(day.date, today);
  const href = `/reports/checks/${day.date}`;
  return html`<li class="reports__record" data-day="${escapeAttr(day.date)}">
    <div class="reports__record-head">
      <a
        class="reports__record-title"
        href="${escapeAttr(href)}"
        aria-label="${escapeAttr(t("reports.day.open", { title }))}"
        >${escapeHtml(title)}</a
      >
      ${statusPill(day.status)}
    </div>
    <p class="reports__record-sub">
      ${escapeHtml(
        day.required > 0
          ? t("reports.day.completedOf", {
              completed: day.completed,
              required: day.required,
            })
          : recordedLine(day),
      )}
    </p>
    ${day.issueCount
      ? html`<a class="reports__record-issues" href="${escapeAttr(href)}"
          >${escapeHtml(t("reports.day.issues", { count: day.issueCount }))}</a
        >`
      : ""}
  </li>`;
}

/* ---- Day detail ---- */

/**
 * @typedef {object} CheckDetail
 * @property {any} check CHECK# header
 * @property {Array<{ artifactId: string, url?: string, kind: "photo" | "text" }>} evidence
 * @property {any[]} tasks tasks created from this check
 */

/**
 * @param {{ day: DaySummary, today: string, checks: CheckDetail[], siteName?: string }} vm
 */
export function dayDetail({ day, today, checks, siteName = "" }) {
  const missing = Math.max(0, day.required - day.completed);
  const dayIsToday = day.date === today;
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
            ${escapeHtml(dayTitle(day.date, today))} ${statusPill(day.status)}
          </h1>
          <p class="topbar__sub">
            ${escapeHtml(
              day.required > 0
                ? t("reports.day.requiredCompletedOf", {
                    completed: day.completed,
                    required: day.required,
                  })
                : recordedLine(day),
            )}
            ${day.issueCount
              ? html`<br />${escapeHtml(
                    t("reports.day.issues", { count: day.issueCount }),
                  )}`
              : ""}
          </p>
        </div>
      </header>
      <ol
        class="reports-timeline"
        aria-label="${escapeAttr(t("reports.day.timelineAria"))}"
      >
        ${checks.map((detail) => checkTimelineItem(detail, siteName)).join("")}
        ${Array.from({ length: missing }, () =>
          missingCheckItem(dayIsToday),
        ).join("")}
      </ol>
    </div>
  `;
}

/** @param {CheckDetail} detail @param {string} siteName */
function checkTimelineItem({ check, evidence, tasks }, siteName) {
  const when = check.completedAt || check.startedAt || "";
  const photos = evidence.filter((e) => e.kind === "photo");
  const meta = [
    photos.length
      ? t("reports.check.photos", { count: photos.length })
      : t("reports.check.description"),
    check.issueCount
      ? t("reports.day.issues", { count: check.issueCount })
      : t("reports.check.noIssues"),
  ].join(" · ");
  return html`<li class="reports-timeline__item reports-timeline__item--done">
    <span class="reports-timeline__mark" aria-hidden="true">✓</span>
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
                          src="${escapeAttr(photo.url)}"
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
 * The home hub's task card (design frame 04), read-only but for its
 * "View or add updates" row: a manager's record neither deletes nor
 * completes field tasks. The row opens the 311 request sheet when a ticket
 * was filed and the updates timeline otherwise.
 * @param {any} task hydrated by the day view (evidence, media, 311 status)
 * @param {string} siteName
 */
export function reportTaskCard(task, siteName) {
  return taskAnalysisCard({
    task,
    siteName,
    isNew: false,
    includeControls: false,
    statusLabel: "",
    action: {
      kind: submitted311Ticket(task) ? "view311" : "update",
      label: t("card.viewUpdates"),
      variant: "outline",
    },
  });
}

/** @param {boolean} dayIsToday */
function missingCheckItem(dayIsToday) {
  return html`<li
    class="reports-timeline__item ${dayIsToday
      ? "reports-timeline__item--due"
      : "reports-timeline__item--missed"}"
  >
    <span class="reports-timeline__mark" aria-hidden="true"
      >${dayIsToday ? "…" : "✕"}</span
    >
    <h2 class="reports-timeline__time">
      ${escapeHtml(
        t(dayIsToday ? "reports.check.due" : "reports.check.missing"),
      )}
    </h2>
    <p class="reports-timeline__meta">
      ${escapeHtml(
        t(dayIsToday ? "reports.check.dueNote" : "reports.check.missingNote"),
      )}
    </p>
  </li>`;
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
 * }} vm shownTypes: how many type rows before "View all" (default TYPE_ROWS)
 */
export function issuesTab({ report, filters, shown, shownTypes = TYPE_ROWS }) {
  const { period, tasks, previous } = report;
  const summary = summarizeIssues(tasks || []);
  const periodOver = periodEnd(period) < report.today;
  const rows = issueRows(tasks || []);
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
              t("reports.issues.respondedLine", { count: summary.responded }),
            )}${periodOver
              ? html` ·
                ${escapeHtml(
                  countDeltaLine(summary.total, previous.count, period.kind),
                )}`
              : ""}
          </p>
        </div>`
      : html`<p class="reports__status" role="status">
          ${escapeHtml(t("reports.issues.none"))}
        </p>`}
    ${summary.total
      ? html`<div class="reports__card">
            ${dailyIssuesChart(tasks || [], period)}
          </div>
          <div class="reports__card">
            <h3 class="reports__card-title">
              ${escapeHtml(t("reports.issues.types.title"))}
            </h3>
            <ul class="reports-types">
              ${summary.byCategory
                .slice(0, shownTypes)
                .map((entry) => typeRow(entry, period))
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
          </div>
          <div class="reports__card">
            <h3 class="reports__card-title">
              ${escapeHtml(t("reports.issues.responses.title"))}
            </h3>
            <ul class="reports-responses">
              ${RESPONSE_KINDS.map(
                (kind) =>
                  html`<li
                    class="reports-responses__item reports-responses__item--${kind}"
                  >
                    <span
                      class="reports-responses__dot"
                      aria-hidden="true"
                    ></span>
                    ${escapeHtml(
                      t(`reports.issues.responses.${kind}`, {
                        count: summary.responses[kind],
                      }),
                    )}
                  </li>`,
              ).join("")}
            </ul>
          </div>`
      : ""}
    ${summary.total
      ? html`<section
          class="reports__records"
          aria-labelledby="reports-issues-title"
        >
          <h2 class="reports__records-title" id="reports-issues-title">
            ${escapeHtml(t("reports.issues.recent.title"))}
          </h2>
          <p class="reports__records-sub">${escapeHtml(periodLabel(period))}</p>
          ${rows.length
            ? html`<ol class="reports__record-list">
                ${visible.map(issueRow).join("")}
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
function typeRow(entry, period) {
  return html`<li class="reports-types__item">
    <a
      class="reports-types__link"
      href="${escapeAttr(typeHref(entry.key, period))}"
      aria-label="${escapeAttr(
        t("reports.issues.types.open", { type: entry.category }),
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
 *   report: { period: Period, today: string, tasks: any[], previous: { count: number, byType?: Record<string, number> } },
 *   key: string,
 *   shown: number,
 *   siteName?: string,
 * }} vm tasks already hydrated by the view (evidence, media, 311 status)
 */
export function typeScreen({ report, key, shown, siteName = "" }) {
  const { period } = report;
  const tasks = issuesOfType(report.tasks || [], key);
  if (!tasks.length) return typeNotFound(issuesTabHref(period));
  const title = issueTypeTitle(tasks, key);
  const periodOver = periodEnd(period) < report.today;
  const headline = t("reports.type.headline", {
    count: tasks.length,
    period: periodLabel(period),
  });
  const visible = tasks.slice(0, shown);
  return html`
    <div class="flow reports reports-day reports-type">
      <header class="topbar">
        <a
          class="topbar__back reports-day__back"
          href="${escapeAttr(issuesTabHref(period))}"
          aria-label="${escapeAttr(t("reports.type.back"))}"
        >
          <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
        </a>
        <div class="topbar__titles">
          <h1
            class="topbar__title reports-day__title"
            tabindex="-1"
            data-screen-focus
          >
            ${escapeHtml(title)}
          </h1>
          <p class="reports-type__headline">${escapeHtml(headline)}</p>
          <p class="topbar__sub">
            ${periodOver
              ? html`${escapeHtml(
                    countDeltaLine(
                      tasks.length,
                      report.previous?.byType?.[key] || 0,
                      period.kind,
                    ),
                  )}<br />`
              : ""}${escapeHtml(lastReportedLabel(tasks[0].createdAt || ""))}
          </p>
        </div>
      </header>
      <div class="reports__card">
        ${dailyIssuesChart(tasks, period, {
          title: t("reports.type.chartTitle", { type: title }),
          level: "h2",
        })}
      </div>
      <section class="reports__records" aria-labelledby="reports-type-title">
        <h2 class="reports__records-title" id="reports-type-title">
          ${escapeHtml(t("reports.type.records.title"))}
        </h2>
        <p class="reports__records-sub">${escapeHtml(headline)}</p>
        <ol class="reports-type__cards">
          ${visible
            .map((task) => html`<li>${reportTaskCard(task, siteName)}</li>`)
            .join("")}
        </ol>
        ${tasks.length > visible.length
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
    </div>
  `;
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

/** @param {ReturnType<typeof issueRows>[number]} row */
function issueRow(row) {
  return html`<li
    class="reports__record"
    data-task-id="${escapeAttr(row.taskId)}"
  >
    <div class="reports__record-head">
      <span class="reports__record-title">${escapeHtml(row.title)}</span>
      <span class="reports-pill reports-pill--${escapeAttr(row.response.kind)}"
        >${escapeHtml(t(`reports.issues.kind.${row.response.kind}`))}</span
      >
    </div>
    <p class="reports__record-sub">
      ${escapeHtml(formatMonthDayTime(row.createdAt))}${row.shortId
        ? html` · ${escapeHtml(row.shortId)}`
        : ""}
    </p>
    <p class="reports__record-sub">
      ${escapeHtml(
        t("reports.issues.response.label", { response: row.response.label }),
      )}
    </p>
  </li>`;
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
    <svg
      class="reports-chart"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="${escapeAttr(
        t("reports.issues.weekChartAria", { weeks: weeks.length }),
      )}"
    >
      ${bars}
    </svg>
    ${chartLabelRow(monthTicks(weeks))}
    <ul class="reports-legend">
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--found"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.chart.found"))}
      </li>
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--responded"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.chart.responded"))}
      </li>
    </ul>
    <table class="visually-hidden">
      <caption>
        ${escapeHtml(t("reports.issues.weekChartTable"))}
      </caption>
      <thead>
        <tr>
          <th scope="col">${escapeHtml(t("reports.filters.period"))}</th>
          <th scope="col">${escapeHtml(t("reports.issues.chart.found"))}</th>
          <th scope="col">
            ${escapeHtml(t("reports.issues.chart.responded"))}
          </th>
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
                <td>${week.found}</td>
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
    <svg
      class="reports-chart"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="${escapeAttr(
        t("reports.issues.chartAria", { days: days.length }),
      )}"
    >
      ${bars}
    </svg>
    ${chartLabelRow(labels.map((text) => ({ text, grow: 1 })))}
    <ul class="reports-legend">
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--found"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.chart.found"))}
      </li>
      <li class="reports-legend__item">
        <span
          class="reports-legend__dot reports-legend__dot--responded"
          aria-hidden="true"
        ></span>
        ${escapeHtml(t("reports.issues.chart.responded"))}
      </li>
    </ul>
    <table class="visually-hidden">
      <caption>
        ${escapeHtml(t("reports.issues.chartTable"))}
      </caption>
      <thead>
        <tr>
          <th scope="col">${escapeHtml(t("reports.filters.period"))}</th>
          <th scope="col">${escapeHtml(t("reports.issues.chart.found"))}</th>
          <th scope="col">
            ${escapeHtml(t("reports.issues.chart.responded"))}
          </th>
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
                <td>${day.found}</td>
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
