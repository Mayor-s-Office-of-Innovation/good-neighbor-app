// Kept apart from the element, so its markup can be tested without a page.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import {
  CONTACT_STATES,
  MAX_REPORT_SITES,
  MAX_SEARCH,
  OVERVIEW_FILTERS,
  RESPONSE_FILTERS,
  SHOW,
  SITE_SORTS,
} from "./insights-query.js";
import {
  codeKey,
  contactWord,
  formatInstant,
  noDataFor,
  periodLabel,
  severityKnown,
  severityWord,
} from "./insights.templates.js";

/** @typedef {import("./insights-query.js").OverviewState} OverviewState */
/** @typedef {import("./report-job.js").ReportState} ReportState */
/** @typedef {import("./insights-session.js").Option} Option */
/** @typedef {import("./insights-session.js").FilterOptions} FilterOptions */
/** @typedef {Record<string, any>} SiteRow */

// Shown in this order, worst first, so Overdue never hides behind On time.
const RESPONSE_ORDER = [
  "overdue",
  "late",
  "awaiting",
  "onTime",
  "unknown",
  "notTimed",
];

/**
 * Options load after the page, so they're refilled in place.
 * @param {string} allLabel
 * @param {Option[]} options
 * @param {string} selected
 */
export function optionsView(allLabel, options, selected) {
  // A value from a link that the options don't list still shows as chosen.
  const listed =
    selected && !options.some((o) => o.value === selected)
      ? [...options, { value: selected, label: selected }]
      : options;
  return `<wa-option value="">${escapeHtml(allLabel)}</wa-option>${listed
    .map(
      (o) =>
        `<wa-option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</wa-option>`,
    )
    .join("")}`;
}

/** @param {string} name @param {string} allLabel @param {Option[]} options @param {string} selected */
function select(name, allLabel, options, selected) {
  return `<wa-select data-filter="${name}" data-all-label="${escapeHtml(allLabel)}" aria-label="${escapeHtml(allLabel)}" placeholder="${escapeHtml(allLabel)}" value="${escapeHtml(selected)}" size="s" pill>${optionsView(allLabel, options, selected)}</wa-select>`;
}

/** @param {string} prefix translation key prefix @param {readonly string[]} values @returns {Option[]} */
const fixedOptions = (prefix, values) =>
  values.map((value) => ({ value, label: t(`${prefix}.${value}`) }));

/** Drawn once; later changes update it in place, so search keeps focus. @param {OverviewState} state @param {FilterOptions} options */
export function filtersView(state, options) {
  return `<div class="insights__filters">
    <wa-input id="insights-search" type="search" value="${escapeHtml(state.q)}" placeholder="${escapeHtml(t("admin.insights.search"))}" aria-label="${escapeHtml(t("admin.insights.search"))}" maxlength="${MAX_SEARCH}" size="s" pill with-clear><wa-icon name="magnifying-glass" slot="start" aria-hidden="true"></wa-icon></wa-input>
    <div class="insights__show">
      <div class="insights__seg" role="group" aria-label="${escapeHtml(t("admin.insights.show.label"))}" aria-describedby="insights-show-help">${SHOW.map(
        (value) =>
          `<button type="button" class="btn-secondary" data-show="${value}" aria-pressed="${state.show === value}">${escapeHtml(t(`admin.insights.show.${value}`))}</button>`,
      ).join("")}</div>
      <p class="muted insights__help" id="insights-show-help">${escapeHtml(t("admin.insights.show.help"))}</p>
    </div>
    <div class="insights__selects" role="group" aria-label="${escapeHtml(t("admin.insights.filters"))}" aria-describedby="insights-filter-help">
      ${select("managerId", t("admin.insights.filter.managerId"), options.managerId, state.managerId)}
      ${select("providerId", t("admin.insights.filter.providerId"), options.providerId, state.providerId)}
      ${select("department", t("admin.insights.filter.department"), options.department, state.department)}
      ${select("responseState", t("admin.insights.filter.responseState"), fixedOptions("admin.insights.filter.response", RESPONSE_FILTERS), state.responseState)}
      ${select("publicContact", t("admin.insights.filter.publicContact"), fixedOptions("admin.insights.filter.publicContact", CONTACT_STATES), state.publicContact)}
      ${select("siteContact", t("admin.insights.filter.siteContact"), fixedOptions("admin.insights.filter.siteContact", CONTACT_STATES), state.siteContact)}
    </div>
    <p class="muted insights__help" id="insights-filter-help">${escapeHtml(t("admin.insights.filter.help"))}</p>
  </div>`;
}

/** @param {SiteRow} row */
function responseSummary(row) {
  const parts = RESPONSE_ORDER.filter((k) => row.response[k] > 0).map(
    (k) =>
      `<span data-response="${k}">${escapeHtml(t("admin.insights.responseCount", { count: row.response[k], state: t(`admin.insights.response.${k}`) }))}</span>`,
  );
  return parts.length
    ? `<span class="insights__list">${parts.join("")}</span>`
    : `<span class="muted">${escapeHtml(t("admin.insights.noIssues"))}</span>`;
}

/** @param {string} key @param {string} fallback */
const wordFor = (key, fallback) => t(hasKey(key) ? key : fallback);

/** @param {SiteRow} row */
function concernsCell(row) {
  // A reason added on the server later reads as a plain concern, not a key.
  const words = new Set([
    ...row.concerns.map((/** @type {string} */ c) =>
      wordFor(`admin.insights.concern.${c}`, "admin.insights.otherConcern"),
    ),
    ...row.unknownEvidence.map((/** @type {string} */ u) =>
      wordFor(
        `admin.insights.unknownEvidence.${u}`,
        "admin.insights.otherUnknownEvidence",
      ),
    ),
  ]);
  return words.size
    ? `<span class="insights__list">${[...words].map((w) => `<span>${escapeHtml(w)}</span>`).join("")}</span>`
    : `<span class="muted">${escapeHtml(t("admin.insights.none"))}</span>`;
}

/** @param {SiteRow} row @param {{ selected: Set<string>, full: boolean, siteHref: (id: string) => string, names: Record<string, Map<string, string>> }} view */
function siteRow(row, { selected, full, siteHref, names }) {
  const picked = selected.has(row.siteId);
  const label = (/** @type {string} */ key) =>
    `data-label="${escapeHtml(t(`admin.insights.col.${key}`))}"`;
  const dims = [
    row.department,
    row.managerId && (names.managerId.get(row.managerId) ?? row.managerId),
  ].filter(Boolean);
  return `<tr role="row" data-site-row="${escapeHtml(row.siteId)}">
    <td role="cell"><wa-checkbox data-select-site="${escapeHtml(row.siteId)}" aria-label="${escapeHtml(t("admin.insights.selectSite", { name: row.name ?? row.siteId }))}" ${picked ? "checked" : ""} ${!picked && full ? "disabled" : ""}></wa-checkbox></td>
    <th role="rowheader" scope="row" ${label("site")}><a href="${escapeHtml(siteHref(row.siteId))}" data-route data-site-link="${escapeHtml(row.siteId)}">${escapeHtml(row.name ?? row.siteId)}</a>${
      dims.length
        ? `<div class="muted">${dims.map((d) => escapeHtml(d)).join(" · ")}</div>`
        : ""
    }${row.status === "inactive" ? `<div class="muted">${escapeHtml(t("admin.insights.inactive"))}</div>` : ""}</th>
    <td role="cell" class="insights__num" ${label("checks")}>${escapeHtml(row.activity.completedPerimeterChecks)}</td>
    <td role="cell" ${label("response")}>${responseSummary(row)}</td>
    <td role="cell" ${label("publicContact")} data-contact="public">${escapeHtml(contactWord(row.publicContact))}</td>
    <td role="cell" ${label("siteContact")} data-contact="site">${escapeHtml(contactWord(row.siteContact))}</td>
    <td role="cell" ${label("issues")} data-issues>${
      row.activity.issuesCreated
        ? escapeHtml(
            !severityKnown(row.maxSeverity)
              ? t("admin.insights.issuesNoSeverity", {
                  count: row.activity.issuesCreated,
                })
              : t("admin.insights.issuesHighest", {
                  count: row.activity.issuesCreated,
                  severity: severityWord(row.maxSeverity),
                }),
          )
        : `<span class="muted">${escapeHtml(t("admin.insights.noIssues"))}</span>`
    }</td>
    <td role="cell" ${label("concerns")} data-concerns>${concernsCell(row)}</td>
  </tr>`;
}

/** Count, select-all and sort sit outside the table, so a load leaves them in place. @param {OverviewState} state */
export function resultBarView(state) {
  return `<div class="insights__resultbar">
    <p role="status" id="insights-count" tabindex="-1"></p>
    <wa-checkbox id="insights-select-all" disabled>${escapeHtml(t("admin.insights.selectAll", { max: MAX_REPORT_SITES }))}</wa-checkbox>
    <wa-select data-filter="sort" aria-label="${escapeHtml(t("admin.insights.sort.label"))}" value="${escapeHtml(state.sort)}" size="s" pill>${SITE_SORTS.map(
      (s) =>
        `<wa-option value="${s}">${escapeHtml(t(`admin.insights.sort.${s}`))}</wa-option>`,
    ).join("")}</wa-select>
  </div>`;
}

/** @param {Record<string, any>} reply @returns {string} */
export function countText(reply) {
  const rows = reply.sites.length;
  const count = reply.siteCount;
  const offset = reply.offset ?? 0;
  return rows && count > rows
    ? t("admin.insights.showing", {
        from: offset + 1,
        to: offset + rows,
        count,
      })
    : t("admin.insights.siteCount", { count });
}

/** Select all keeps the user's own picks, so its state counts them all. @param {string[]} pageIds @param {string[]} selected */
export function selectAllState(pageIds, selected) {
  const full =
    selected.length >= Math.min(MAX_REPORT_SITES, pageIds.length) &&
    selected.length > 0;
  return { checked: full, indeterminate: !full && selected.length > 0 };
}

/** @param {{ reply: Record<string, any>, state: OverviewState, siteHref: (id: string) => string, names: Record<string, Map<string, string>>, notice: string }} view */
export function resultsView({ reply, state, siteHref, names, notice }) {
  const rows = /** @type {SiteRow[]} */ (reply.sites);
  const interval = reply.meta.interval;
  const selected = new Set(state.selected);
  const full = selected.size >= MAX_REPORT_SITES;
  const note = notice
    ? `<p class="muted" data-insights-notice>${escapeHtml(notice)}</p>`
    : "";
  // An old link can land past the last page; Previous gets back.
  if (!rows.length)
    return `${note}${emptyView(reply, state)}${pagerView(reply)}`;
  return `${note}
  <div class="table-wrap insights__table" data-insights-table>
    <table role="table">
      <caption class="visually-hidden">${escapeHtml(t("admin.insights.tableCaption", { period: periodLabel(interval) }))}</caption>
      <thead role="rowgroup"><tr role="row">
        <th role="columnheader" scope="col"><span class="visually-hidden">${escapeHtml(t("admin.insights.col.select"))}</span></th>
        ${[
          "site",
          "checks",
          "response",
          "publicContact",
          "siteContact",
          "issues",
          "concerns",
        ]
          .map(
            (key) =>
              `<th role="columnheader" scope="col" ${key === "checks" ? 'class="insights__num"' : ""}>${escapeHtml(t(`admin.insights.col.${key}`))}</th>`,
          )
          .join("")}
      </tr></thead>
      <tbody role="rowgroup">${rows.map((row) => siteRow(row, { selected, full, siteHref, names })).join("")}</tbody>
    </table>
  </div>
  ${pagerView(reply)}`;
}

/** @param {Record<string, any>} reply */
function pagerView(reply) {
  const offset = reply.offset ?? 0;
  if (!offset && !reply.nextCursor) return "";
  return `<nav class="insights__pager" aria-label="${escapeHtml(t("admin.insights.pages"))}">
    <button type="button" class="btn-secondary" data-page="prev" ${offset ? "" : "disabled"}>${escapeHtml(t("admin.insights.previousPage"))}</button>
    <button type="button" class="btn-secondary" data-page="next" ${reply.nextCursor ? "" : "disabled"}>${escapeHtml(t("admin.insights.nextPage"))}</button>
  </nav>`;
}

/** Each empty case offers the one step that shows Sites again. @param {Record<string, any>} reply @param {OverviewState} state */
function emptyView(reply, state) {
  if (noDataFor(reply.meta))
    return `<p class="empty-state" data-insights-empty="no-data">${escapeHtml(t("admin.insights.empty.noRows"))}</p>`;
  if (reply.offset > 0)
    return `<p class="empty-state" data-insights-empty="past-end">${escapeHtml(t("admin.insights.empty.pastEnd"))}</p>`;
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

/** Updated in place, so focus stays and screen readers hear one live region. */
export function reportBarView() {
  return `<div class="insights__report">
    <button type="button" class="btn-primary" id="insights-report" disabled></button>
    <p class="muted" id="insights-report-hint"></p>
  </div>
  <div role="status" id="insights-report-status" tabindex="-1"></div>`;
}

/** @param {{ selected: number, job: ReportState | null }} view */
export function reportBarText({ selected, job }) {
  const busy = !!job && ["starting", "queued", "running"].includes(job.phase);
  return {
    busy,
    button: selected
      ? t("admin.insights.report.buttonCount", { count: selected })
      : t("admin.insights.report.button"),
    hint: selected
      ? t("admin.insights.report.selected", {
          count: selected,
          max: MAX_REPORT_SITES,
        })
      : t("admin.insights.report.hint", { max: MAX_REPORT_SITES }),
  };
}

/** @param {ReportState} job @param {boolean} linkStale the signed link has run out */
export function jobView(job, linkStale) {
  const count = job.siteCount;
  if (job.phase === "starting")
    return `<p>${escapeHtml(t("admin.insights.report.starting"))}</p>`;
  if (job.phase === "queued" || job.phase === "running") {
    // The job runs on while status reads fail, so the page keeps asking.
    const delayed = job.error
      ? ` <span class="muted" data-report-delayed>${escapeHtml(t("admin.insights.report.checkDelayed"))}</span>`
      : "";
    return `<p>${escapeHtml(t("admin.insights.report.working", { count }))} <button type="button" class="btn-link" id="insights-report-cancel">${escapeHtml(t("admin.insights.report.cancel"))}</button>${delayed}</p>`;
  }
  if (job.phase === "succeeded") {
    const url = job.job?.downloadUrl;
    // A ready report with no link yet can still ask for one.
    const link =
      !url || linkStale
        ? `<button type="button" class="btn-link" id="insights-report-refresh">${escapeHtml(t("admin.insights.report.refresh"))}</button>`
        : `<a href="${escapeHtml(url)}" id="insights-report-download" target="_blank" rel="noopener">${escapeHtml(t("admin.insights.report.download"))}</a>`;
    const kept = job.job?.expiresAt
      ? escapeHtml(
          t("admin.insights.report.kept", {
            time: formatInstant(job.job.expiresAt),
          }),
        )
      : "";
    const failed = job.error
      ? `<span class="error">${escapeHtml(t("admin.insights.report.refreshFailed"))}</span>`
      : "";
    return `<p>${[escapeHtml(t("admin.insights.report.ready", { count })), link, failed, kept].filter(Boolean).join(" ")}</p>`;
  }
  if (job.phase === "cancelled")
    return `<p>${escapeHtml(t("admin.insights.report.cancelled"))}</p>`;
  const key = codeKey("admin.insights.report.error", job.error);
  return `<p class="error" data-report-error="${escapeHtml(job.error)}">${escapeHtml(hasKey(key) ? t(key) : t("admin.insights.report.error.generic"))}</p>`;
}

/** @param {{ count: number, period: string, time: string }} view */
export function reportDialogView({ count, period, time }) {
  return `<dialog id="insights-report-dialog" class="places-modal" aria-labelledby="insights-report-title" aria-describedby="insights-report-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="insights-report-title">${escapeHtml(t("admin.insights.report.title", { count }))}</h2>
        <p class="places-modal__text" id="insights-report-copy">${escapeHtml(t("admin.insights.report.body", { period, time }))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="cancel">${escapeHtml(t("common.cancel"))}</button>
        <button class="btn-primary" value="confirm" id="insights-report-confirm">${escapeHtml(t("admin.insights.report.confirm"))}</button>
      </div>
    </form>
  </dialog>`;
}
