// Raw data list markup: the controls, the Issue and Check lists and the CSV export.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import {
  formatDateTime,
  pacificDateKey,
} from "../../../../frontend/src/i18n/dates.js";
import { dayInstant } from "../../../../frontend/src/domain/reports-periods.js";
import { escapeHtml } from "../../dom.js";
import { jobButtonView, resultBarView } from "./job-action.js";
import { controlRow, select, severityView } from "./overview.templates.js";
import {
  categoryWord,
  formatInstant,
  helpTip,
  noDataFor,
  openColumnHead,
  openMarkerCell,
  periodLabel,
  severityBand,
} from "./insights.templates.js";
import {
  LINK_ONLY,
  MAX_EXPORT_ROWS,
  RECORD_FILTERS,
  SITE_FILTERS,
  isFiltered,
} from "./raw-query.js";

/** @typedef {import("./raw-query.js").RawKind} RawKind */
/** @typedef {import("./raw-query.js").RawState} RawState */
/** @typedef {import("./insights-session.js").Option} Option */
/** @typedef {Record<string, any>} Row */

/** @param {string} key a word that may not be translated yet @param {string} fallback */
export const wordFor = (key, fallback) => t(hasKey(key) ? key : fallback);

// Admin copy is English in every locale, so numbers group the English way.
const grouped = new Intl.NumberFormat("en-US");
const plurals = new Intl.PluralRules("en-US");

/** @param {number} value e.g. "250,000" */
export const formatCount = (value) => grouped.format(value);

/**
 * t() shows a count as "12345"; this shows "12,345 Issues".
 * @param {string} key a key with .one and .other forms
 * @param {number} count
 * @param {Record<string, string | number>} [params]
 */
export function countWords(key, count, params = {}) {
  const form = `${key}.${plurals.select(count)}`;
  return t(hasKey(form) ? form : `${key}.other`, {
    ...params,
    count: formatCount(count),
  });
}

/** Categories are stored as the rulebook's English, so that is the filter value. @param {string[]} categories @returns {Option[]} */
export function categoryOptions(categories) {
  return categories
    .map((value) => ({ value, label: categoryWord(value) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Colour only adds to the word beside it, so screen readers skip the dot. @param {number | null} severity */
export const dotView = (severity) =>
  `<span class="insights__sev" data-severity="${severityBand(severity)}"><span class="insights__dot" aria-hidden="true"></span></span>`;

/** @param {Row} row */
export const issueStateWord = (row) =>
  t(`admin.insights.issueStatus.${row.resolvedAt ? "resolved" : "open"}`);

/** @param {string} state */
export const responseWord = (state) =>
  wordFor(
    `admin.insights.response.${state}`,
    "admin.insights.response.unknown",
  );

// Late answers need a look; Unknown is a data gap, not a Site's doing.
/** @param {string} state */
export const responseClass = (state) =>
  state === "overdue" || state === "late"
    ? "insights__warn"
    : state === "unknown"
      ? "insights__unknown"
      : "";

/** @param {Row} check */
export const checkStateWord = (check) =>
  t(
    `admin.insights.raw.state.${check.state === "completed" ? "completed" : "unfinished"}`,
  );

/** @param {Row} check e.g. "Oct 2, 10:00 AM", or "Started Oct 2, 9:50 AM" for an unfinished one */
export function checkTime(check) {
  return check.state === "completed"
    ? formatInstant(check.completedAt ?? check.activityAt)
    : t("admin.insights.raw.startedAt", {
        time: formatInstant(check.startedAt ?? check.activityAt),
      });
}

// The words the lists and records already use, so a filter option never names a state differently.
const OPTION_WORDS = {
  issueStatus: "admin.insights.issueStatus",
  severityBand: "admin.insights.severity",
  responseState: "admin.insights.response",
  state: "admin.insights.raw.state",
};

/**
 * A link-only value in use is listed too, so the select names it in words.
 * @param {string} name
 * @param {readonly string[]} values
 * @param {string} selected
 * @returns {Option[]}
 */
export function fixedOptions(name, values, selected) {
  const prefix = /** @type {Record<string, string>} */ (OPTION_WORDS)[name];
  const extra = /** @type {Record<string, string[]>} */ (LINK_ONLY)[name] ?? [];
  return [...values, ...extra.filter((value) => value === selected)].map(
    (value) => ({ value, label: t(`${prefix}.${value}`) }),
  );
}

/** A Site page link can name several Sites; the select then shows how many. @param {RawState} state @param {Option[]} sites */
export function siteOptions(state, sites) {
  if (state.siteIds.length < 2) return sites;
  return [
    ...sites,
    {
      value: state.siteIds.join(","),
      label: t("admin.insights.raw.siteCount", {
        count: state.siteIds.length,
      }),
    },
  ];
}

/** @param {RawKind} kind @param {RawState} state @returns {string} e.g. "Filters (2)" */
export function filtersToggleText(kind, state) {
  const names = [
    ...(state.siteIds.length ? ["siteIds"] : []),
    ...[...SITE_FILTERS, ...Object.keys(RECORD_FILTERS[kind])].filter(
      (name) => state.filters[name],
    ),
  ];
  return names.length
    ? t("admin.insights.raw.filtersOn", { count: names.length })
    : t("admin.insights.raw.filters");
}

/** Drawn once; options fill in later, in place. @param {RawKind} kind @param {RawState} state @param {Record<string, Option[]>} options */
export function rawFiltersView(kind, state, options) {
  const field = (/** @type {string} */ name) =>
    t(`admin.insights.field.${name}`);
  const sites = select(
    "siteIds",
    t("admin.insights.filter.siteIds"),
    siteOptions(state, options.siteIds ?? []),
    state.siteIds.join(","),
    { label: field("siteIds") },
  );
  const site = SITE_FILTERS.map((name) =>
    select(
      name,
      t(`admin.insights.filter.${name}`),
      options[name] ?? [],
      state.filters[name],
      { label: field(name) },
    ),
  );
  const records = Object.entries(RECORD_FILTERS[kind]).map(([name, values]) =>
    select(
      name,
      t(`admin.insights.raw.${name}`),
      values
        ? fixedOptions(name, values, state.filters[name])
        : (options[name] ?? []),
      state.filters[name],
      { label: field(name) },
    ),
  );
  const tip =
    kind === "checks"
      ? helpTip(
          "insights-tip-checks",
          t("admin.insights.label.checks"),
          t("admin.insights.raw.checksTip"),
        )
      : "";
  // Phones fold the filter rows away, so the list starts on the first screen.
  return `<div class="insights__controls" id="insights-controls">
    ${controlRow("period", '<div data-region="period"></div>')}
    <button type="button" class="btn-secondary insights__filters-toggle" id="insights-filters-toggle" aria-expanded="false" aria-controls="insights-filter-rows">${escapeHtml(filtersToggleText(kind, state))}</button>
    <div class="insights__filter-rows" id="insights-filter-rows">
      ${controlRow("filter", `${sites}${site.join("")}`)}
      ${controlRow(kind, `${records.join("")}${tip}`)}
    </div>
  </div>`;
}

export function rawHeadView() {
  return `<div class="page-head insights__head" data-raw-head>
    <h1 id="insights-title" tabindex="-1">${escapeHtml(t("admin.insights.raw"))}</h1>
  </div>`;
}

/** Links, not tabs, so each list has its own address to share. @param {RawKind} kind @param {string} query the carried period */
export function rawTabsView(kind, query) {
  return `<nav class="entity-tabs" aria-label="${escapeHtml(t("admin.insights.rawLabel"))}">${
    /** @type {RawKind[]} */ (["issues", "checks"])
      .map(
        (k) =>
          `<a href="/insights/raw/${k}${escapeHtml(query)}" data-route data-insights-raw="${k}" ${k === kind ? 'aria-current="page"' : ""}>${escapeHtml(t(`admin.insights.${k}`))}</a>`,
      )
      .join("")
  }</nav>`;
}

/** Group by, the count and Export CSV, laid out as on Overview. @param {RawKind} kind @param {RawState} state */
export function rawBarView(kind, state) {
  const group =
    kind === "issues"
      ? `<label class="insights__sortlabel" for="insights-group">${escapeHtml(t("admin.insights.raw.group"))}</label>
        <wa-select id="insights-group" value="${escapeHtml(state.group)}" size="s" pill>${[
          "latest",
          "created",
          "site",
        ]
          .map(
            (g) =>
              `<wa-option value="${g}">${escapeHtml(t(`admin.insights.raw.group.${g}`))}</wa-option>`,
          )
          .join("")}</wa-select>`
      : "";
  return resultBarView({
    start: group,
    end: jobButtonView(
      "insights-export",
      t("admin.insights.export.button"),
      "btn-secondary",
    ),
  });
}

/** @param {RawKind} kind @param {Row} reply */
export function countText(kind, reply) {
  return countWords(`admin.insights.raw.${kind}Count`, reply.total, {
    period: periodLabel(reply.meta.interval),
  });
}

/** @param {number | null} total @returns {string} why Export CSV is off, or "" */
export function exportWhyOff(total) {
  if (total === null) return "";
  if (!total) return t("admin.insights.export.nothing");
  if (total > MAX_EXPORT_ROWS)
    return t("admin.insights.export.tooMany", {
      max: formatCount(MAX_EXPORT_ROWS),
    });
  return "";
}

/** @param {{ kind: RawKind, count: number }} view */
export function exportDialogView({ kind, count }) {
  return `<dialog id="insights-export-dialog" class="places-modal" aria-labelledby="insights-export-title" aria-describedby="insights-export-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="insights-export-title">${escapeHtml(countWords(`admin.insights.export.title.${kind}`, count))}</h2>
        <p class="places-modal__text" id="insights-export-copy">${escapeHtml(countWords(`admin.insights.export.body.${kind}`, count))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn-primary" value="confirm" id="insights-export-confirm">${escapeHtml(t("admin.insights.export.confirm"))}</button>
      </div>
    </form>
  </dialog>`;
}

/** @param {Row} row */
export const recordKey = (row) => `${row.siteId}|${row.issueId ?? row.checkId}`;

/** @param {string} kind @param {string} key */
const col = (kind, key) =>
  `<th role="columnheader" scope="col" ${key === "issues" ? 'class="insights__num"' : ""}>${escapeHtml(t(`admin.insights.raw.${kind}.${key}`))}</th>`;

/** Phones show each row as a labelled card, so no field drops. @param {string} kind @param {string} key */
const label = (kind, key) =>
  `data-label="${escapeHtml(t(`admin.insights.raw.${kind}.${key}`))}"`;

/** @param {Row} row */
const siteName = (row) => row.siteName || row.siteId;

const ISSUE_COLUMNS = ["category", "site", "severity", "status", "response"];

/**
 * One Issue row; the category link opens the side panel, and keeps its
 * record URL for a new tab.
 * @param {Row} issue
 * @param {(row: Row) => string} href
 * @param {string[]} [columns]
 */
export function issueRow(issue, href, columns = ISSUE_COLUMNS) {
  const state = issue.responseState;
  /** @type {Record<string, string>} */
  const cells = {
    category: `<th role="rowheader" scope="row" ${label("issue", "category")}><a href="${escapeHtml(href(issue))}" data-route data-record-link="${escapeHtml(recordKey(issue))}" data-panel-kind="issue" data-panel-id="${escapeHtml(issue.issueId)}" data-panel-site="${escapeHtml(issue.siteId)}">${escapeHtml(categoryWord(issue.category))}</a></th>`,
    site: `<td role="cell" ${label("issue", "site")}>${escapeHtml(siteName(issue))}</td>`,
    // The dot sits beside its word, as on Overview and the Site page.
    severity: `<td role="cell" ${label("issue", "severity")}>${severityView(issue.severity)}</td>`,
    status: `<td role="cell" ${label("issue", "status")}${issue.resolvedAt ? ' class="muted" data-muted' : ""}>${escapeHtml(issueStateWord(issue))}</td>`,
    response: `<td role="cell" ${label("issue", "response")} data-response="${escapeHtml(state)}"><span class="${responseClass(state)}">${escapeHtml(responseWord(state))}</span></td>`,
  };
  return `<tr role="row" data-issue-row="${escapeHtml(issue.issueId)}">${columns.map((c) => cells[c]).join("")}${openMarkerCell}</tr>`;
}

/** @param {string} day YYYY-MM-DD @returns {string} e.g. "Monday · Sep 28" */
export function dayHeading(day) {
  const at = dayInstant(day);
  return t("admin.insights.raw.dayHeading", {
    weekday: formatDateTime(at, { weekday: "long" }),
    date: formatDateTime(at, { month: "short", day: "numeric" }),
  });
}

/**
 * Sites group by ID, so two Sites with one name stay apart.
 * @param {Row} issue
 * @param {string} group
 * @returns {[string, string]} key, heading
 */
function groupOf(issue, group) {
  if (group === "site") return [issue.siteId, siteName(issue)];
  const day =
    group === "created"
      ? issue.createdDay
      : pacificDateKey(issue.latestActivityAt ?? issue.createdAt);
  return [day, dayHeading(day)];
}

/** @typedef {{ key: string, heading: string, issues: Row[] }} IssueGroup */

/**
 * Rows come sorted by the grouping, so equal keys are always together.
 * @param {Row[]} rows
 * @param {string} group
 * @returns {IssueGroup[]}
 */
export function issueGroups(rows, group) {
  /** @type {IssueGroup[]} */
  const groups = [];
  for (const issue of rows) {
    const [key, heading] = groupOf(issue, group);
    const last = groups.at(-1);
    if (last?.key === key) last.issues.push(issue);
    else groups.push({ key, heading, issues: [issue] });
  }
  return groups;
}

/** @param {Row[]} issues @param {(row: Row) => string} href */
export const issueRowsView = (issues, href) =>
  issues.map((issue) => issueRow(issue, href)).join("");

/** @param {IssueGroup} group @param {(row: Row) => string} href */
export const issueGroupView = ({ key, heading, issues }, href) =>
  `<tbody role="rowgroup" data-issue-group="${escapeHtml(key)}">
        <tr role="row"><th role="rowheader" scope="rowgroup" colspan="${ISSUE_COLUMNS.length + 1}" class="insights__grouphead" data-group-head>${escapeHtml(heading)}</th></tr>
        ${issueRowsView(issues, href)}
      </tbody>`;

/** @param {Row[]} checks @param {(row: Row) => string} href */
export const checkRowsView = (checks, href) =>
  checks
    .map(
      (c) => `<tr role="row" data-check-row="${escapeHtml(c.checkId)}">
        <th role="rowheader" scope="row" ${label("check", "site")}><a href="${escapeHtml(href(c))}" data-route data-record-link="${escapeHtml(recordKey(c))}" data-panel-kind="check" data-panel-id="${escapeHtml(c.checkId)}" data-panel-site="${escapeHtml(c.siteId)}">${escapeHtml(siteName(c))}</a></th>
        <td role="cell" ${label("check", "time")}${c.state === "completed" ? "" : ' class="muted" data-muted'}>${escapeHtml(checkTime(c))}</td>
        <td role="cell" ${label("check", "state")}${c.state === "completed" ? "" : ' class="insights__unknown" data-muted'}>${escapeHtml(checkStateWord(c))}</td>
        <td role="cell" class="insights__num" ${label("check", "issues")}>${escapeHtml(c.issues ?? 0)}</td>
        ${openMarkerCell}
      </tr>`,
    )
    .join("");

/** @param {RawKind} kind @param {Row} reply @param {RawState} state */
function emptyView(kind, reply, state) {
  if (noDataFor(reply.meta))
    return `<p class="empty-state" data-insights-empty="no-data">${escapeHtml(t(`admin.insights.raw.noData.${kind}`))}</p>`;
  if (isFiltered(state))
    return `<div class="empty-state" data-insights-empty="filtered">
      <h2>${escapeHtml(t(`admin.insights.raw.noMatchTitle.${kind}`))}</h2>
      <p class="muted">${escapeHtml(t(`admin.insights.raw.noMatch.${kind}`, { period: periodLabel(reply.meta.interval) }))}</p>
      <button type="button" class="btn-secondary" id="insights-clear-filters">${escapeHtml(t("admin.insights.clearFilters"))}</button>
    </div>`;
  return `<p class="empty-state" data-insights-empty="none">${escapeHtml(t(`admin.insights.raw.none.${kind}`))}</p>`;
}

/**
 * @typedef {{ rows: Row[], reply: Row, state: RawState, href: (row: Row) => string, more: string, notice: string, stale: string }} ListView
 * more: "" with no more rows, "ready", "loading", or an error to show by the button;
 * stale: the reason a reload failed, with these rows still shown under it
 */

/**
 * Its own region, so Load more redraws it without touching the rows above.
 * @param {{ more: string, rows: Row[], reply: Row }} view
 */
export function moreView({ more, rows, reply }) {
  if (!more) return "";
  const failed =
    more !== "ready" && more !== "loading"
      ? `<p class="error">${escapeHtml(more)}</p>`
      : "";
  const shown = `<span class="muted" data-shown>${escapeHtml(t("admin.insights.raw.showing", { shown: formatCount(rows.length), total: formatCount(reply.total) }))}</span>`;
  return `<div class="insights__more" data-load-more-row>${failed}<div class="insights__more-row"><button type="button" class="btn-secondary" id="insights-load-more" ${more === "loading" ? "disabled" : ""}>${escapeHtml(t("admin.status.loadMore"))}</button>${shown}</div></div>`;
}

/** @param {ListView} view */
function bannersView({ notice, stale }) {
  return `${
    stale
      ? `<div class="insights__quality insights__stale" data-insights-stale><p>${escapeHtml(stale)}</p><button type="button" class="btn-secondary" id="insights-retry">${escapeHtml(t("common.retry"))}</button></div>`
      : ""
  }${notice ? `<p class="muted" data-insights-notice>${escapeHtml(notice)}</p>` : ""}`;
}

/** @param {ListView} view */
export function issuesView(view) {
  const { rows, reply, state, href } = view;
  if (!rows.length)
    return `${bannersView(view)}${emptyView("issues", reply, state)}`;
  return `${bannersView(view)}
  <div class="table-wrap insights__table insights__table--paged" data-insights-table>
    <table role="table">
      <caption class="visually-hidden">${escapeHtml(t(`admin.insights.raw.groupCaption.${state.group}`))}</caption>
      <thead role="rowgroup"><tr role="row">${ISSUE_COLUMNS.map((k) => col("issue", k)).join("")}${openColumnHead()}</tr></thead>
      ${issueGroups(rows, state.group)
        .map((group) => issueGroupView(group, href))
        .join("")}
    </table>
  </div>
  <div data-more-region>${moreView(view)}</div>`;
}

/** @param {ListView} view */
export function checksView(view) {
  const { rows, reply, state, href } = view;
  if (!rows.length)
    return `${bannersView(view)}${emptyView("checks", reply, state)}`;
  return `${bannersView(view)}
  <div class="table-wrap insights__table insights__table--paged" data-insights-table>
    <table role="table">
      <caption class="visually-hidden">${escapeHtml(t("admin.insights.raw.checksCaption"))}</caption>
      <thead role="rowgroup"><tr role="row">${["site", "time", "state", "issues"].map((k) => col("check", k)).join("")}${openColumnHead()}</tr></thead>
      <tbody role="rowgroup" data-check-rows>${checkRowsView(rows, href)}</tbody>
    </table>
  </div>
  <div data-more-region>${moreView(view)}</div>`;
}
