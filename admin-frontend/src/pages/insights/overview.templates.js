// Kept apart from the element, so its markup can be tested without a page.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { CONCERN_RULES } from "./concern-rules.js";
import {
  MAX_SEARCH,
  OVERVIEW_FILTERS,
  SHOW,
  sortDir,
} from "./insights-query.js";
import { jobButtonView, resultBarView } from "./job-action.js";
import {
  helpTip,
  noDataFor,
  oneDecimal,
  periodLabel,
  severityBand,
} from "./insights.templates.js";

/** @typedef {import("./insights-query.js").OverviewState} OverviewState */
/** @typedef {import("./insights-session.js").Option} Option */
/** @typedef {import("./insights-session.js").FilterOptions} FilterOptions */
/** @typedef {Record<string, any>} SiteRow */

/**
 * Options load after the page, so they're refilled in place.
 * @param {string} allLabel
 * @param {Option[]} options
 * @param {string} selected
 * @param {string} [me] the signed-in manager's ID; listed first so they find their own Sites at once
 */
export function optionsView(allLabel, options, selected, me = "") {
  // A value from a link that the options don't list still shows as chosen.
  const listed =
    selected && !options.some((o) => o.value === selected)
      ? [...options, { value: selected, label: selected }]
      : options;
  const own = me ? listed.find((o) => o.value === me) : undefined;
  const rest = own
    ? listed
        .filter((o) => o !== own)
        .sort((a, b) => a.label.localeCompare(b.label))
    : listed;
  /** @param {Option} o @param {string} [label] */
  const option = (o, label = o.label) =>
    `<wa-option value="${escapeHtml(o.value)}">${escapeHtml(label)}</wa-option>`;
  return `<wa-option value="">${escapeHtml(allLabel)}</wa-option>${
    own
      ? `${option(own, t("admin.insights.filter.me", { name: own.label }))}<wa-divider></wa-divider>`
      : ""
  }${rest.map((o) => option(o)).join("")}`;
}

/**
 * @param {string} name
 * @param {string} allLabel
 * @param {Option[]} options
 * @param {string} selected
 * @param {string} [me]
 */
function select(name, allLabel, options, selected, me = "") {
  return `<wa-select data-filter="${name}" data-all-label="${escapeHtml(allLabel)}" aria-label="${escapeHtml(allLabel)}" placeholder="${escapeHtml(allLabel)}" value="${escapeHtml(selected)}" size="s" pill>${optionsView(allLabel, options, selected, me)}</wa-select>`;
}

/** @param {string} key admin.insights.label.* @param {string} body */
const controlRow = (key, body) =>
  `<div class="insights__crow"><span class="insights__clabel" id="insights-label-${key}" data-control-label="${key}">${escapeHtml(t(`admin.insights.label.${key}`))}</span><div class="insights__cbody">${body}</div></div>`;

/**
 * Drawn once; later changes update it in place, so search keeps focus.
 * @param {OverviewState} state
 * @param {FilterOptions} options
 * @param {string} [me] the signed-in manager's ID; "" for anyone who manages no Sites
 */
export function filtersView(state, options, me = "") {
  return `<div class="insights__controls">
    ${controlRow("search", `<wa-input id="insights-search" type="search" value="${escapeHtml(state.q)}" placeholder="${escapeHtml(t("admin.insights.search"))}" aria-label="${escapeHtml(t("admin.insights.search"))}" maxlength="${MAX_SEARCH}" size="s" pill with-clear><wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon></wa-input>`)}
    ${controlRow("period", '<div data-region="period"></div>')}
    ${controlRow(
      "status",
      `<div class="insights__seg" role="group" aria-labelledby="insights-label-status">${SHOW.map(
        (value) =>
          `<button type="button" class="btn-plain" data-show="${value}" aria-pressed="${state.show === value}">${escapeHtml(t(`admin.insights.show.${value}`))}</button>`,
      ).join("")}</div>${helpTip(
        "insights-tip-status",
        t("admin.insights.label.status"),
        t("admin.insights.show.help", {
          severe: CONCERN_RULES.severeIssues,
          issues: CONCERN_RULES.issuesPer30Days,
          days: CONCERN_RULES.unresolvedDays,
        }),
      )}`,
    )}
    ${controlRow(
      "filter",
      `${select("managerId", t("admin.insights.filter.managerId"), options.managerId, state.managerId, me)}
      ${select("providerId", t("admin.insights.filter.providerId"), options.providerId, state.providerId)}
      ${select("department", t("admin.insights.filter.department"), options.department, state.department)}
      ${helpTip("insights-tip-filter", t("admin.insights.label.filter"), t("admin.insights.filter.help"))}`,
    )}
  </div>`;
}

/** @param {string} key */
const muted = (key) => `<span class="muted">${escapeHtml(t(key))}</span>`;
// Before the records begin, a zero would claim a quiet period.
const unavailable = () =>
  `<span class="insights__unknown">${escapeHtml(t("admin.insights.unavailable"))}</span>`;

/** Overdue and late both missed the response time, so they count together. @param {SiteRow} row */
const late = (row) => row.response.overdue + row.response.late;

/** The bar is full at the Site shown with the most, so rows compare at a glance. @param {SiteRow} row @param {number} most */
function lateCount(row, most) {
  const count = late(row);
  const full = most > 0 ? count / most : 0;
  return `<span class="insights__meter-n" data-late-count>${escapeHtml(count)}</span><span class="insights__meter" role="img" aria-label="${escapeHtml(t("admin.insights.lateMeter", { count, most }))}"><span style="inline-size:${Math.round(full * 100)}%"></span></span>`;
}

/** The Site page's Checks a day, so the two pages never disagree. @param {SiteRow} row */
function checksMeter(row) {
  const perDay = row.checksPerDay;
  if (perDay === null || perDay === undefined)
    return muted("admin.insights.none");
  const value = oneDecimal(perDay);
  const number = `<span class="insights__meter-n" data-checks-per-day>${escapeHtml(value)}</span>`;
  const owed = row.checksOwedPerDay;
  // A Site that owes no Checks has no target, so a bar would invent one.
  if (owed === null || owed === undefined) return number;
  const full = owed > 0 ? Math.min(perDay / owed, 1) : 1;
  return `${number}<span class="insights__meter" role="img" data-checks-meter aria-label="${escapeHtml(t("admin.insights.checksMeter", { value, owed }))}"><span style="inline-size:${Math.round(full * 100)}%"></span></span>`;
}

/** @param {string} word @param {string} [kind] */
const chip = (word, kind = "") =>
  `<span class="insights__chip${kind ? ` insights__chip--${kind}` : ""}">${escapeHtml(word)}</span>`;

/** The server's rate, so the column matches the Many Issues flag. @param {SiteRow} row @returns {number | null} */
const per30 = (row) => row.issuesPer30Days ?? null;

/** The bar is full at the busiest Site shown, so rows compare at a glance. @param {number | null} value @param {number} most */
function issuesPer30(value, most) {
  if (value === null) return muted("admin.insights.none");
  const shown = oneDecimal(value);
  const full = most > 0 ? value / most : 0;
  return `<span class="insights__meter-n" data-issues-per-30d>${escapeHtml(shown)}</span><span class="insights__meter" role="img" aria-label="${escapeHtml(t("admin.insights.issuesMeter", { value: shown, most: oneDecimal(most) }))}"><span style="inline-size:${Math.round(full * 100)}%"></span></span>`;
}

/** @param {string} band minor, moderate, severe or unknown */
export function bandView(band) {
  return `<span class="insights__sev" data-severity="${band}"><span class="insights__dot" aria-hidden="true"></span>${escapeHtml(t(`admin.insights.severity.${band}`))}</span>`;
}

/** @param {number | null} severity */
export function severityView(severity) {
  return bandView(severityBand(severity));
}

/** @param {SiteRow} row @param {{ selected: Set<string>, noData: boolean, siteHref: (id: string) => string, names: Record<string, Map<string, string>>, most: { issues: number, late: number } }} view */
function siteRow(row, { selected, noData, siteHref, names, most }) {
  // Phones show each row as a labelled card, so cells carry their column name.
  const label = (/** @type {string} */ key) =>
    `data-label="${escapeHtml(t(`admin.insights.col.${key}`))}"`;
  const manager =
    row.managerId && (names.managerId.get(row.managerId) ?? row.managerId);
  // A closed Site needs no public contact, so it gets no chip.
  const noPublic =
    row.status !== "inactive" && row.publicContact?.state === "missing";
  return `<tr role="row" data-site-row="${escapeHtml(row.siteId)}">
    <td role="cell"><wa-checkbox data-select-site="${escapeHtml(row.siteId)}" aria-label="${escapeHtml(t("admin.insights.selectSite", { name: row.name ?? row.siteId }))}" ${selected.has(row.siteId) ? "checked" : ""}></wa-checkbox></td>
    <th role="rowheader" scope="row" ${label("site")}><a href="${escapeHtml(siteHref(row.siteId))}" data-route data-site-link="${escapeHtml(row.siteId)}">${escapeHtml(row.name ?? row.siteId)}</a>${
      manager
        ? `<div class="muted" data-manager="${escapeHtml(row.managerId)}">${escapeHtml(manager)}</div>`
        : ""
    }${row.status === "inactive" ? `<div class="muted">${escapeHtml(t("admin.insights.inactive"))}</div>` : ""}${
      noPublic
        ? `<div data-no-public>${chip(t("admin.insights.noPublicContact"), "flag")}</div>`
        : ""
    }</th>
    <td role="cell" class="insights__num" ${label("checks")} data-checks>${
      noData ? unavailable() : checksMeter(row)
    }</td>
    <td role="cell" class="insights__num" ${label("response")} data-response-cell>${noData ? unavailable() : lateCount(row, most.late)}</td>
    <td role="cell" ${label("severity")} data-issues>${
      noData
        ? unavailable()
        : row.activity.issuesCreated
          ? severityView(row.maxSeverity)
          : muted("admin.insights.none")
    }</td>
    <td role="cell" class="insights__num" ${label("issuesPer30d")} data-issues-rate>${noData ? unavailable() : issuesPer30(per30(row), most.issues)}</td>
    <td role="cell" class="insights__chev" aria-hidden="true"><wa-icon name="chevron-right"></wa-icon></td>
  </tr>`;
}

/** Outside the table, so a load leaves them in place. */
export function overviewBarView() {
  return resultBarView({
    start: "",
    end: jobButtonView("insights-report", t("admin.insights.report.button")),
  });
}

/**
 * @param {Record<string, any>} reply
 * @param {OverviewState} state
 * @param {number | null} total every Site, once known
 * @returns {string} e.g. "22 Sites (out of 500)" when the view or filters narrow the list
 */
export function countText(reply, state, total) {
  const count = reply.siteCount;
  const narrowed =
    state.show !== "all" ||
    [state.q, ...OVERVIEW_FILTERS.map((k) => state[k])].some(Boolean);
  return narrowed && total !== null && total > count
    ? t("admin.insights.siteCountOf", { count, total })
    : t("admin.insights.siteCount", { count });
}

/** The header box ticks when every listed Site is picked. @param {string[]} listedIds @param {string[]} selected */
export function selectAllState(listedIds, selected) {
  const picked = new Set(selected);
  const all = listedIds.length > 0 && listedIds.every((id) => picked.has(id));
  return { checked: all, indeterminate: !all && selected.length > 0 };
}

// The column header that orders by each sort key.
/** @type {Record<string, string>} */
const SORT_COLUMN = {
  name: "site",
  checksPerDay: "checks",
  overdueLate: "response",
  maxSeverity: "severity",
  issuesPer30Days: "issuesPer30d",
};

/** @param {string} key admin.insights.col.* @param {boolean} num @param {OverviewState} state */
function columnHead(key, num, state) {
  const tip = hasKey(`admin.insights.colHelp.${key}`)
    ? helpTip(
        `insights-tip-col-${key}`,
        t(`admin.insights.col.${key}`),
        t(`admin.insights.colHelp.${key}`),
      )
    : "";
  const words = t(`admin.insights.col.${key}`).split(" ");
  const last = words.pop();
  const cls = num ? 'class="insights__num"' : "";
  const sortKey = Object.keys(SORT_COLUMN).find((s) => SORT_COLUMN[s] === key);
  if (!sortKey)
    // The "?" stays on the line with the last word instead of wrapping alone.
    return `<th role="columnheader" scope="col" ${cls}>${escapeHtml(words.join(" "))} <span class="insights__nowrap" data-sort-last>${escapeHtml(last ?? "")}${tip}</span></th>`;
  const sorted = state.sort === sortKey;
  const dir = sortDir(state);
  const ariaSort = sorted
    ? dir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  const arrow = sorted ? (dir === "asc" ? "↑" : "↓") : "↕";
  return `<th role="columnheader" scope="col" ${cls} aria-sort="${ariaSort}"><button type="button" class="btn-plain insights__sort${sorted ? " is-sorted" : ""}" data-sort-key="${sortKey}">${escapeHtml(words.join(" "))} <span class="insights__nowrap" data-sort-last>${escapeHtml(last ?? "")}<span class="insights__sort-arrow" aria-hidden="true">${arrow}</span></span></button>${tip}</th>`;
}

/**
 * shown: rows drawn so far; the rest wait for Load more.
 * @param {{ reply: Record<string, any>, state: OverviewState, siteHref: (id: string) => string, names: Record<string, Map<string, string>>, shown?: number }} view
 */
export function resultsView({
  reply,
  state,
  siteHref,
  names,
  shown = Infinity,
}) {
  const rows = /** @type {SiteRow[]} */ (reply.sites);
  const interval = reply.meta.interval;
  const selected = new Set(state.selected);
  const noData = noDataFor(reply.meta);
  if (!rows.length) return emptyView(reply, state);
  const most = {
    issues: Math.max(0, ...rows.map((row) => per30(row) ?? 0)),
    late: Math.max(...rows.map(late)),
  };
  return `<div class="table-wrap insights__table" data-insights-table>
    <table role="table">
      <caption class="visually-hidden">${escapeHtml(t("admin.insights.tableCaption", { period: periodLabel(interval) }))}</caption>
      <thead role="rowgroup"><tr role="row">
        <th role="columnheader" scope="col"><wa-checkbox id="insights-select-all" aria-label="${escapeHtml(t("admin.insights.selectAll"))}"></wa-checkbox></th>
        ${columnHead("site", false, state)}${columnHead("checks", true, state)}${columnHead("response", true, state)}${columnHead("severity", false, state)}${columnHead("issuesPer30d", true, state)}
        <th role="columnheader" scope="col"><span class="visually-hidden">${escapeHtml(t("admin.insights.col.open"))}</span></th>
      </tr></thead>
      <tbody role="rowgroup">${rows
        .slice(0, shown)
        .map((row) => siteRow(row, { selected, noData, siteHref, names, most }))
        .join("")}</tbody>
    </table>
  </div>${rows.length > shown ? `<button type="button" class="btn-secondary insights__more" data-more-sites>${escapeHtml(t("admin.status.loadMore"))}</button>` : ""}`;
}

/** Each empty case offers the one step that shows Sites again. @param {Record<string, any>} reply @param {OverviewState} state */
function emptyView(reply, state) {
  if (noDataFor(reply.meta))
    return `<p class="empty-state" data-insights-empty="no-data">${escapeHtml(t("admin.insights.empty.noRows"))}</p>`;
  const filtered = [state.q, ...OVERVIEW_FILTERS.map((k) => state[k])].some(
    Boolean,
  );
  const showAll = `<button type="button" class="btn-secondary" data-show="all">${escapeHtml(t("admin.insights.showAll"))}</button>`;
  if (!filtered && state.show === "top")
    return `<div class="empty-state" data-insights-empty="top"><p>${escapeHtml(t("admin.insights.empty.top"))}</p>${showAll}</div>`;
  if (!filtered && state.show === "unknown")
    return `<div class="empty-state" data-insights-empty="unknown"><p>${escapeHtml(t("admin.insights.empty.unknown"))}</p>${showAll}</div>`;
  if (!filtered)
    return `<p class="empty-state" data-insights-empty="none">${escapeHtml(t("admin.insights.empty.noRows"))}</p>`;
  // Top concerns or Unknown data may be what hides the rows, not the filters.
  return `<div class="empty-state" data-insights-empty="filtered"><p>${escapeHtml(t("admin.insights.empty.filtered"))}</p><button type="button" class="btn-secondary" id="insights-clear-filters">${escapeHtml(t("admin.insights.clearFilters"))}</button>${state.show === "all" ? "" : showAll}</div>`;
}

/** @param {number} selected @returns {{ label: string, why: string }} */
export function reportButtonText(selected) {
  return selected
    ? {
        label: t("admin.insights.report.buttonCount", { count: selected }),
        why: "",
      }
    : {
        label: t("admin.insights.report.button"),
        why: t("admin.insights.report.needSites"),
      };
}

/** @param {{ count: number }} view */
export function reportDialogView({ count }) {
  return `<dialog id="insights-report-dialog" class="places-modal" aria-labelledby="insights-report-title">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="insights-report-title">${escapeHtml(t("admin.insights.report.title", { count }))}</h2>
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn-primary" value="confirm" id="insights-report-confirm">${escapeHtml(t("admin.insights.report.confirm"))}</button>
      </div>
    </form>
  </dialog>`;
}
