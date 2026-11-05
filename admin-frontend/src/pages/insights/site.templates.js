// Site insights markup, in the mock's order: Concerns, Contacts, Activity, Issue Response Time.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { rulebookText } from "../../../../frontend/src/i18n/rulebook.js";
import { phoneWithExtension } from "../shared.templates.js";
import { activityChart, chartUnit } from "./activity-chart.js";
import { CONCERN_RULES } from "./concern-rules.js";
import {
  codeKey,
  contactWord,
  failedView,
  formatDay,
  formatInstant,
  helpTip,
  noDataFor,
  oneDecimal,
  perDayText,
} from "./insights.templates.js";
import { severityView } from "./overview.templates.js";

/** @typedef {Record<string, any>} Reply */
/** @typedef {{ publicContact?: Record<string, string>, primaryContact?: Record<string, string> } | null} ContactDetails the Site's Manage record */

const ACTIVITY = [
  "completedPerimeterChecks",
  "issuesCreated",
  "singleIssueReports",
];
// The mock's five; no response time is never late, so it has no tile.
export const RESPONSE_TILES = [
  "overdue",
  "late",
  "awaiting",
  "onTime",
  "unknown",
];
const WARN = new Set(["overdue", "late"]);

/** Opens on Overdue, else Responded late, so the list shows what needs a look. @param {Reply} reply */
export function firstTile(reply) {
  const counts = reply.totals.response;
  return counts.overdue ? "overdue" : counts.late ? "late" : "";
}

/** @param {{ site: Reply | null, siteId: string, names: Map<string, string>, back: string }} view */
export function siteHeadView({ site, siteId, names, back }) {
  const name = site?.name || (site ? siteId : t("admin.insights.site"));
  const meta = site
    ? [
        site.managerId &&
          t("admin.insights.siteMeta.manager", {
            name: names.get(site.managerId) ?? site.managerId,
          }),
        site.status === "inactive" && t("admin.insights.inactive"),
      ].filter((part) => typeof part === "string")
    : [];
  return `<nav class="entity-breadcrumb" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}"><ol>
    <li><a id="insights-back" href="${escapeHtml(back)}" data-route>${escapeHtml(t("admin.insights.overview"))}</a></li>
    <li><span aria-hidden="true">›</span><span aria-current="page">${escapeHtml(name)}</span></li>
  </ol></nav>
  <div class="page-head"><h1 id="insights-title" tabindex="-1">${escapeHtml(name)}</h1></div>${
    meta.length
      ? `<p class="muted" data-site-meta>${meta.map((m) => escapeHtml(m)).join(" · ")}</p>`
      : ""
  }`;
}

/** The period opens in a popover, so it doesn't push the page down. @param {{ label: string, range: string }} view */
export function sitePeriodView({ label, range }) {
  return `<div class="insights__psel">
    <button type="button" class="btn-secondary" id="insights-period-toggle" popovertarget="insights-period-pop" aria-haspopup="dialog" style="anchor-name:--insights-period-pop"><span data-period-button>${escapeHtml(label)}</span> <wa-icon name="chevron-down" aria-hidden="true"></wa-icon></button>
    <div id="insights-period-pop" popover class="insights__ppop" role="dialog" aria-label="${escapeHtml(t("admin.insights.period.choose"))}" style="position-anchor:--insights-period-pop"><div data-period-body></div></div>
    <span class="muted" data-period-range>${escapeHtml(range)}</span>
  </div>`;
}

/**
 * Each flag's why, with the numbers it was judged on.
 * @param {Reply} reply
 * @returns {Record<string, Record<string, string | number>>}
 */
function concernParams(reply) {
  const { response, activity } = reply.totals;
  const rules = CONCERN_RULES;
  return {
    fewChecks: {
      perDay: oneDecimal(reply.checksPerDay ?? 0),
      min: rules.checksPerDay,
    },
    repeatedSevere: { count: activity.severeIssues, min: rules.severeIssues },
    manyIssues: { count: activity.issuesCreated, max: rules.issuesPer30Days },
    longUnresolved: {
      count: reply.longUnresolved ?? 0,
      days: rules.unresolvedDays,
    },
    overdue: { count: response.overdue },
    late: { count: response.late },
  };
}

/** @param {string} code @param {Reply} reply @param {string} issuesHref */
function concernLine(code, reply, issuesHref) {
  const key = `admin.insights.concern.${code}`;
  const params = concernParams(reply)[code];
  // A reason added on the server later still shows, as a plain word.
  if (!hasKey(key) || !params)
    return `<li>${escapeHtml(t("admin.insights.otherConcern"))}</li>`;
  const link =
    code === "overdue" || code === "late"
      ? `<button type="button" class="btn-link" data-jump-tile="${code}">${escapeHtml(t("admin.insights.seeTile", { state: t(`admin.insights.response.${code}`) }))}</button>`
      : code === "fewChecks"
        ? `<a href="#insights-activity">${escapeHtml(t("admin.insights.seeActivity"))}</a>`
        : `<a href="${escapeHtml(issuesHref)}" data-route>${escapeHtml(t("admin.insights.viewIssues"))}</a>`;
  return `<li data-concern="${code}"><strong>${escapeHtml(t(key))}:</strong> ${escapeHtml(t(`admin.insights.concernWhy.${code}`, params))} ${link}</li>`;
}

/** Only a Site with concerns gets the box. @param {Reply} reply @param {string} issuesHref */
function concernsView(reply, issuesHref) {
  const codes = /** @type {string[]} */ (reply.concerns ?? []);
  if (!codes.length) return "";
  return `<div class="insights__concerns" role="note" data-site-concerns><strong>${escapeHtml(t("admin.insights.col.concerns"))}</strong><ul>${codes
    .map((code) => concernLine(code, reply, issuesHref))
    .join("")}</ul></div>`;
}

/** @param {{ state: string, reasonCodes: string[] }} contact */
function contactState(contact) {
  // A reason added on the server later shows the state alone, not a key.
  const reasons = contact.reasonCodes
    .map((code) => codeKey("admin.insights.reason", code))
    .filter((key) => hasKey(key))
    .map((key) => t(key));
  return `<div class="${contact.state === "missing" ? "insights__warn" : contact.state === "unknown" ? "insights__unknown" : ""}">${escapeHtml(contactWord(contact))}</div>${
    reasons.length
      ? `<div class="muted">${reasons.map((r) => escapeHtml(r)).join(" ")}</div>`
      : ""
  }`;
}

/** @param {Record<string, string> | undefined} person @param {boolean} named */
function contactLines(person, named) {
  if (!person) return "";
  const name = named
    ? [person.firstName, person.lastName].filter(Boolean).join(" ")
    : "";
  const phone = phoneWithExtension(person);
  return [
    name && `<strong>${escapeHtml(name)}</strong>`,
    person.email &&
      `<a href="mailto:${escapeHtml(person.email)}">${escapeHtml(person.email)}</a>`,
    person.phone &&
      `<a href="tel:${escapeHtml(person.phone)}">${escapeHtml(phone)}</a>`,
  ]
    .filter(Boolean)
    .map((line) => `<div>${line}</div>`)
    .join("");
}

/**
 * The details come from Manage's record, read once; until then, or if that
 * read fails, each contact shows its state alone.
 * @param {{ reply: Reply, details: ContactDetails }} view
 */
export function contactsView({ reply, details }) {
  /** @param {string} kind @param {{ state: string, reasonCodes: string[] }} contact @param {Record<string, string> | undefined} person */
  const cell = (kind, contact, person) => {
    const lines =
      contact.state === "available"
        ? contactLines(person, kind === "site")
        : "";
    return `<div data-contact="${kind}"><p class="insights__clabel">${escapeHtml(t(`admin.insights.contacts.${kind}`))}</p>${lines || contactState(contact)}</div>`;
  };
  return `${cell("public", reply.publicContact, details?.publicContact)}${cell("site", reply.siteContact, details?.primaryContact)}`;
}

/** @param {string} key @param {string} value already escaped @param {string} label @param {string} help @param {string} [note] already escaped */
const tile = (key, value, label, help, note = "") =>
  `<div class="insights__tile" data-activity="${key}"><span class="insights__tile-n" data-activity-count>${value}</span><span class="insights__tile-l">${escapeHtml(label)}</span>${note}${helpTip(`insights-tip-activity-${key}`, label, help)}</div>`;

/** @param {Reply} reply @param {string} checksHref */
function activityView(reply, checksHref) {
  const counts = reply.totals.activity;
  const noData = noDataFor(reply.meta);
  const interval = reply.meta.interval;
  const days = /** @type {Reply[]} */ (reply.days);
  /** @param {string} metric */
  const points = (metric) =>
    days.map((d) => ({ day: d.day, value: Number(d[metric] ?? 0) }));
  const unit = chartUnit(interval);
  return `<section class="insights__group" aria-labelledby="insights-activity">
    <h2 id="insights-activity" tabindex="-1">${escapeHtml(t("admin.insights.activity"))}</h2>
    <div class="insights__tiles">${ACTIVITY.map((key) =>
      tile(
        key,
        // Before the records begin, a zero would claim a quiet period (plan §4).
        noData
          ? escapeHtml(t("admin.insights.unavailable"))
          : escapeHtml(counts[key] ?? 0),
        t(`admin.insights.activity.${key}`),
        t(`admin.insights.activityHelp.${key}`, {
          min: CONCERN_RULES.checksPerDay,
        }),
        key === "completedPerimeterChecks" &&
          !noData &&
          reply.checksPerDay !== null &&
          reply.checksPerDay !== undefined
          ? `<span class="insights__tile-l muted" data-checks-per-day>${escapeHtml(perDayText(reply.checksPerDay))}</span>`
          : "",
      ),
    ).join("")}</div>
    <div class="insights__charts">
      <div><h3>${escapeHtml(t(`admin.insights.chart.checks.${unit}`))}</h3>${activityChart(interval, points("completedPerimeterChecks"), "checks")}</div>
      <div><h3>${escapeHtml(t(`admin.insights.chart.issues.${unit}`))}</h3>${activityChart(interval, points("issuesCreated"), "issues")}</div>
    </div>
    ${
      days.length
        ? `<div class="visually-hidden" data-site-days><table>
        <caption>${escapeHtml(t("admin.insights.daily"))}</caption>
        <thead><tr><th scope="col">${escapeHtml(t("admin.insights.daily.day"))}</th><th scope="col">${escapeHtml(t("admin.insights.activity.completedPerimeterChecks"))}</th><th scope="col">${escapeHtml(t("admin.insights.activity.issuesCreated"))}</th></tr></thead>
        <tbody>${days
          .map(
            (d) =>
              `<tr><th scope="row">${escapeHtml(formatDay(d.day))}</th><td>${escapeHtml(d.completedPerimeterChecks)}</td><td>${escapeHtml(d.issuesCreated)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`
        : ""
    }
    <p><a href="${escapeHtml(checksHref)}" data-route id="insights-site-checks">${escapeHtml(t("admin.insights.viewChecks"))}</a></p>
  </section>`;
}

/** @param {Reply} reply @param {string} tile the one selected, or "" */
function responseTilesView(reply, tile) {
  const counts = reply.totals.response;
  return `<div class="insights__tiles insights__tiles--five">${RESPONSE_TILES.map(
    (key) =>
      `<div class="insights__tile${WARN.has(key) && counts[key] ? " insights__tile--warn" : ""}" data-response="${key}"><button type="button" data-tile="${key}" aria-pressed="${key === tile}"><span class="insights__tile-n" data-response-count>${escapeHtml(counts[key] ?? 0)}</span><span class="insights__tile-l">${escapeHtml(t(`admin.insights.response.${key}`))}</span></button>${helpTip(`insights-tip-response-${key}`, t(`admin.insights.response.${key}`), t(`admin.insights.responseHelp.${key}`))}</div>`,
  ).join("")}</div>`;
}

/** @param {Reply} reply @param {string} tile @param {string} issuesHref */
function responseView(reply, tile, issuesHref) {
  const count = reply.totals.activity.issuesCreated;
  const heading = `<h2 id="insights-response">${escapeHtml(t("admin.insights.responseTime"))}${helpTip("insights-tip-deadline", t("admin.insights.responseTime"), t("admin.insights.deadlineNote"))}</h2>`;
  // Before the records begin, no Issues isn't a quiet period.
  const body = noDataFor(reply.meta)
    ? `<p class="muted" data-site-issues-empty>${escapeHtml(t("admin.insights.empty.noIssueData"))}</p>`
    : !count
      ? `<p class="muted" data-site-issues-empty>${escapeHtml(t("admin.insights.noIssuesInPeriod"))}</p>`
      : `${responseTilesView(reply, tile)}<div data-region="issues"></div>
      <p><a href="${escapeHtml(issuesHref)}" data-route id="insights-site-raw">${escapeHtml(t("admin.insights.viewAllIssues", { count }))}</a></p>`;
  return `<section class="insights__group" aria-labelledby="insights-response" id="insights-response-section">${heading}${body}</section>`;
}

/**
 * @param {{ reply: Reply, details: ContactDetails, tile: string, hrefs: { contacts: string, issues: string, checks: string } }} view
 */
export function siteBodyView({ reply, details, tile, hrefs }) {
  return `${concernsView(reply, hrefs.issues)}
  <section class="insights__group" aria-labelledby="insights-contacts">
    <h2 id="insights-contacts">${escapeHtml(t("admin.insights.contacts"))}${helpTip("insights-tip-contacts", t("admin.insights.contacts"), t("admin.insights.contactBasis"))}</h2>
    <div class="insights__contacts" data-region="contacts">${contactsView({ reply, details })}</div>
    <p><a href="${escapeHtml(hrefs.contacts)}" target="_blank" rel="noopener" id="insights-edit-contacts">${escapeHtml(t("admin.insights.editContacts"))} <span aria-hidden="true">↗</span></a></p>
  </section>
  ${activityView(reply, hrefs.checks)}
  ${responseView(reply, tile, hrefs.issues)}`;
}

/** The Issues behind the selected tile. @param {{ issues: Reply | null, failed: string, tile: string, issueHref: (issue: Reply) => string }} view */
export function siteIssuesView({ issues, failed, tile, issueHref }) {
  if (!tile) return "";
  if (failed) return failedView(failed, "insights-issues-retry");
  if (!issues) return "";
  const rows = /** @type {Reply[]} */ (issues.issues);
  if (!rows.length)
    return `<p class="muted" data-site-issues-empty>${escapeHtml(t("admin.insights.noTileIssues", { state: t(`admin.insights.response.${tile}`) }))}</p>`;
  return `<ul class="insights__issues" aria-label="${escapeHtml(t(`admin.insights.response.${tile}`))}">${rows
    .map(
      (
        i,
      ) => `<li data-issue-row="${escapeHtml(i.issueId)}"><a href="${escapeHtml(issueHref(i))}" data-route>
      ${severityView(i.severity)}
      <strong>${escapeHtml(i.category ? rulebookText(i.category, "rulebook.category") : t("admin.insights.issue.categoryUnknown"))}</strong>
      <span class="muted">${escapeHtml(i.deadlineAt ? t("admin.insights.issueWhen", { created: formatInstant(i.createdAt), due: formatInstant(i.deadlineAt) }) : formatInstant(i.createdAt))}</span>
      <span>${escapeHtml(t(`admin.insights.issueStatus.${i.resolvedAt ? "resolved" : "open"}`))}</span>
      <span class="muted">${escapeHtml(i.issueId)}</span>
      <wa-icon name="chevron-right" aria-hidden="true"></wa-icon>
    </a></li>`,
    )
    .join("")}</ul>${
    issues.total > rows.length
      ? `<p class="muted">${escapeHtml(t("admin.insights.issuesShown", { shown: rows.length, count: issues.total }))}</p>`
      : ""
  }`;
}
