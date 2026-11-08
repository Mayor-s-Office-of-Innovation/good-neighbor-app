// Site insights markup, top to bottom: Concerns, Contacts, Activity, Severe Issues, Issue Response Time.
import { resolutionTime } from "../../../../frontend/src/domain/reports-issues.js";
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
  per30Text,
  periodDays,
  severityBand,
} from "./insights.templates.js";
import { bandView } from "./overview.templates.js";
import { contactShown, showsTotal } from "./site-rules.js";

/** @typedef {Record<string, any>} Reply */
/** @typedef {{ publicContact?: Record<string, string>, primaryContact?: Record<string, string> } | null} ContactDetails the Site's Manage record; null until read */

const ACTIVITY = [
  "completedPerimeterChecks",
  "issuesCreated",
  "singleIssueReports",
];
/**
 * Each tiled section: the Issue filter its tiles set, and the tiles it opens
 * on. Response opens on the Issues a manager follows up.
 */
export const SITE_LISTS = Object.freeze({
  severity: {
    heading: "insights-severe",
    param: "severityBand",
    // Worst first, as the response tiles lead with Overdue.
    tiles: ["severe", "moderate", "minor", "unknown"],
    first: "severe",
    // One severity at a time, so the list matches the one count pressed.
    single: true,
    warn: new Set(["severe"]),
    retry: "insights-severe-retry",
  },
  response: {
    heading: "insights-response",
    param: "responseState",
    // An Issue with no response time is never late, so it gets no tile.
    tiles: ["overdue", "late", "awaiting", "onTime", "unknown"],
    first: "overdue,late",
    warn: new Set(["overdue", "late"]),
    retry: "insights-issues-retry",
  },
});

/** @typedef {keyof typeof SITE_LISTS} SiteList */

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
    <span data-period-status></span>
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
    // The flag compares the average over owed days, so the why line shows that one.
    fewChecks: {
      perDay: oneDecimal(reply.checksPerOwedDay ?? 0),
      min: reply.checksOwedPerDay ?? "",
    },
    repeatedSevere: { count: activity.severeIssues, min: rules.severeIssues },
    manyIssues: {
      count: activity.issuesCreated,
      rate: oneDecimal(reply.issuesPer30Days ?? 0),
      max: rules.issuesPer30Days,
    },
    slowResponse: {
      overdue: response.overdue,
      late: response.late,
      open: reply.longUnresolved ?? 0,
      days: rules.unresolvedDays,
    },
  };
}

/**
 * Slow response lists only the parts it found, e.g. "2 Issues responded to late, 1 open over 14 days".
 * @param {string} code
 * @param {Record<string, string | number>} params
 */
function concernWhy(code, params) {
  if (code !== "slowResponse")
    return t(`admin.insights.concernWhy.${code}`, params);
  return ["overdue", "late", "open"]
    .filter((part) => Number(params[part]) > 0)
    .map((part) =>
      t(`admin.insights.concernWhy.slowResponse.${part}`, {
        count: params[part],
        days: params.days,
      }),
    )
    .join(", ")
    .concat(".");
}

/** @param {string} code @param {Reply} reply */
function concernLine(code, reply) {
  const key = `admin.insights.concern.${code}`;
  const params = concernParams(reply)[code];
  // A reason added on the server later still shows, as a plain word.
  if (!hasKey(key) || !params)
    return `<li>${escapeHtml(t("admin.insights.otherConcern"))}</li>`;
  // Severe and slow response have their own Issue lists; other flags are explained by Activity.
  const [to, words] =
    code === "slowResponse"
      ? ["insights-response", "admin.insights.seeResponseTime"]
      : code === "repeatedSevere"
        ? ["insights-severe", "admin.insights.seeSevere"]
        : ["insights-activity", "admin.insights.seeActivity"];
  // Slow response lists its own Issues, since the tiles don't hold every one it counts.
  const list = code === "slowResponse" ? ` data-show-concern="${code}"` : "";
  const link = `<a href="#${to}"${list}>${escapeHtml(t(words))}</a>`;
  return `<li data-concern="${code}"><strong>${escapeHtml(t(key))}:</strong> ${escapeHtml(concernWhy(code, params))} ${link}</li>`;
}

/** Only a Site with concerns gets the box. @param {Reply} reply */
function concernsView(reply) {
  const codes = /** @type {string[]} */ (reply.concerns ?? []);
  if (!codes.length) return "";
  return `<div class="insights__concerns" role="note" data-site-concerns><strong>${escapeHtml(t("admin.insights.concernsTitle"))}</strong><ul>${codes
    .map((code) => concernLine(code, reply))
    .join("")}</ul></div>`;
}

/** @param {{ state: string, reasonCodes: string[] }} contact */
function contactState(contact) {
  // A reason added on the server later shows the state alone, not a key.
  const reasons = contact.reasonCodes
    .map((code) => codeKey("admin.insights.reason", code))
    .filter((key) => hasKey(key))
    .map((key) => t(key));
  const tone =
    contact.state === "missing"
      ? ' class="insights__warn" data-tone="warn"'
      : contact.state === "unknown"
        ? ' class="insights__unknown" data-tone="unknown"'
        : "";
  return `<div${tone}>${escapeHtml(contactWord(contact))}</div>${
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
 * read fails, the report's public contact shows instead.
 * @param {{ reply: Reply, details: ContactDetails }} view
 */
export function contactsView({ reply, details }) {
  /** @param {"public" | "site"} kind @param {{ state: string, reasonCodes: string[] } & Record<string, any>} reported @param {Record<string, string> | undefined} person */
  const cell = (kind, reported, person) => {
    const shown = contactShown(kind, reported, person, details !== null);
    const lines = contactLines(shown.person, kind === "site");
    const state =
      shown.state === "available" && lines ? "" : contactState(shown);
    return `<div data-contact="${kind}"><p class="insights__clabel">${escapeHtml(t(`admin.insights.contacts.${kind}`))}</p>${lines}${state}</div>`;
  };
  return `${cell("public", reply.publicContact, details?.publicContact)}${cell("site", reply.siteContact, details?.primaryContact)}`;
}

/** @param {string} key @param {string} value already escaped @param {string} label @param {string} help @param {string} [note] already escaped */
const tile = (key, value, label, help, note = "") =>
  `<div class="insights__tile" data-activity="${key}"><span class="insights__tile-n" data-tile-n>${value}</span><span class="insights__tile-l">${escapeHtml(label)}</span>${note}${helpTip(`insights-tip-activity-${key}`, label, help)}</div>`;

/**
 * A Site that owed no Checks has no number of its own to name.
 * @param {string} key
 * @param {number | null | undefined} owedPerDay
 */
const activityHelp = (key, owedPerDay) =>
  key === "completedPerimeterChecks" && owedPerDay == null
    ? t("admin.insights.activityHelp.completedPerimeterChecksNoneOwed")
    : t(`admin.insights.activityHelp.${key}`, { min: owedPerDay ?? "" });

/** @param {Reply} reply */
function activityView(reply) {
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
    <div class="insights__tiles">${ACTIVITY.map((key) => {
      const label = t(`admin.insights.activity.${key}`);
      const help = activityHelp(key, reply.checksOwedPerDay);
      const count = counts[key] ?? 0;
      // Before the records begin, a zero would claim a quiet period.
      if (noData)
        return tile(
          key,
          `<span data-activity-count>${escapeHtml(t("admin.insights.unavailable"))}</span>`,
          label,
          help,
        );
      const rate =
        key === "completedPerimeterChecks" &&
        reply.checksPerDay !== null &&
        reply.checksPerDay !== undefined
          ? `<span data-checks-per-day>${escapeHtml(perDayText(reply.checksPerDay))}</span>`
          : key === "issuesCreated" &&
              reply.issuesPer30Days !== null &&
              reply.issuesPer30Days !== undefined
            ? `<span data-issues-per-30d>${escapeHtml(per30Text(reply.issuesPer30Days))}</span>`
            : "";
      if (!rate)
        return tile(
          key,
          `<span data-activity-count>${escapeHtml(count)}</span>`,
          label,
          help,
        );
      const total = showsTotal(key, periodDays(interval))
        ? `<span class="insights__tile-l muted" data-activity-count>${escapeHtml(t(key === "issuesCreated" ? "admin.insights.raw.issuesCount" : "admin.insights.raw.checksCount", { count }))}</span>`
        : "";
      return tile(key, rate, label, help, total);
    }).join("")}</div>
    <div class="insights__charts" data-charts>
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
  </section>`;
}

/** @param {SiteList} list @param {string} key */
const tileWord = (list, key) =>
  t(`admin.insights.${list === "severity" ? "severity" : "response"}.${key}`);

/** @param {SiteList} list @param {string} key */
const tileLabel = (list, key) =>
  list === "severity" ? bandView(key) : escapeHtml(tileWord(list, key));

/** @param {SiteList} list @param {Reply} reply @param {string} tile the values selected, comma-separated, or "" */
function tilesView(list, reply, tile) {
  const { tiles, warn } = SITE_LISTS[list];
  const on = tile.split(",");
  const counts = reply.totals[list] ?? {};
  // data-band and data-response, so each section's tiles are found by name.
  const name = list === "severity" ? "band" : "response";
  return `<div class="insights__tiles insights__tiles--${tiles.length === 5 ? "five" : "four"}">${tiles
    .map(
      (key) =>
        `<div class="insights__tile${warn.has(key) && counts[key] ? " insights__tile--warn" : ""}" data-${name}="${key}"${warn.has(key) && counts[key] ? " data-warn" : ""}><button type="button" class="btn-plain" data-tile="${key}" aria-pressed="${on.includes(key)}"><span class="insights__tile-n" data-${name}-count>${escapeHtml(counts[key] ?? 0)}</span><span class="insights__tile-l">${tileLabel(list, key)}</span></button>${helpTip(`insights-tip-${name}-${key}`, tileWord(list, key), t(`admin.insights.${name === "band" ? "severityHelp" : "responseHelp"}.${key}`))}</div>`,
    )
    .join("")}</div>`;
}

/** @param {SiteList} list @param {Reply} reply @param {string} tile */
function listView(list, reply, tile) {
  const count = reply.totals.activity.issuesCreated;
  const id = SITE_LISTS[list].heading;
  const heading =
    list === "severity"
      ? `<h2 id="${id}" tabindex="-1">${escapeHtml(t("admin.insights.severeIssues"))}</h2>`
      : `<h2 id="${id}" tabindex="-1">${escapeHtml(t("admin.insights.responseTime"))}${helpTip("insights-tip-deadline", t("admin.insights.responseTime"), t("admin.insights.deadlineNote"))}</h2>`;
  // Before the records begin, no Issues isn't a quiet period.
  const body = noDataFor(reply.meta)
    ? `<p class="muted" data-site-issues-empty>${escapeHtml(t("admin.insights.empty.noIssueData"))}</p>`
    : !count
      ? `<p class="muted" data-site-issues-empty>${escapeHtml(t("admin.insights.noIssuesInPeriod"))}</p>`
      : `${tilesView(list, reply, tile)}<div data-region="issues"></div>`;
  return `<section class="insights__group" aria-labelledby="${id}" id="${id}-section" data-list="${list}">${heading}${body}</section>`;
}

/**
 * @param {{ reply: Reply, details: ContactDetails, hrefs: { contacts: string } }} view
 */
export function siteTopView({ reply, details, hrefs }) {
  return `${concernsView(reply)}
  <section class="insights__group" aria-labelledby="insights-contacts">
    <h2 id="insights-contacts">${escapeHtml(t("admin.insights.contacts"))}${helpTip("insights-tip-contacts", t("admin.insights.contacts"), t("admin.insights.contactBasis"))}</h2>
    <div class="insights__contacts" data-region="contacts">${contactsView({ reply, details })}</div>
    <p><a href="${escapeHtml(hrefs.contacts)}" target="_blank" rel="noopener" id="insights-edit-contacts">${escapeHtml(t("admin.insights.editContacts"))} <span aria-hidden="true">↗</span></a></p>
  </section>`;
}

/**
 * The period picker sits between siteTopView and this, just above Activity.
 * @param {{ reply: Reply, tiles: Record<SiteList, string> }} view
 */
export function siteBodyView({ reply, tiles }) {
  return `${activityView(reply)}
  ${listView("severity", reply, tiles.severity)}
  ${listView("response", reply, tiles.response)}`;
}

/** @param {number} ms */
const duration = (ms) =>
  Number.isFinite(ms) && ms >= 0 ? resolutionTime(ms) : "";

/** @param {string} from @param {string | null | undefined} to */
const between = (from, to) =>
  to ? duration(Date.parse(to) - Date.parse(from)) : "";

/** @param {Reply} issue */
function responseTimeCell(issue) {
  const took = between(issue.createdAt, issue.firstResponseAt);
  return took
    ? escapeHtml(took)
    : `<span class="muted" data-tone="muted">${escapeHtml(t("admin.insights.siteIssues.noResponse"))}</span>`;
}

/**
 * Late names the Issue's own allowed time, since severities differ.
 * @param {Reply} issue
 */
function onTimeCell(issue) {
  const state = issue.responseState;
  if (state === "onTime")
    return escapeHtml(t("admin.insights.siteIssues.onTime"));
  if (state === "awaiting")
    return escapeHtml(t("admin.insights.siteIssues.notYetDue"));
  // A 911 rule sets no response time, so it can't be late.
  if (state === "notTimed")
    return escapeHtml(t("admin.insights.response.notTimed"));
  if (state === "late" || state === "overdue") {
    const expected = between(issue.createdAt, issue.deadlineAt);
    const word = expected
      ? t("admin.insights.siteIssues.lateDueWithin", { expected })
      : t("admin.insights.siteIssues.late");
    return `<span class="insights__warn" data-tone="warn">${escapeHtml(word)}</span>`;
  }
  // No response record, or a state the server adds later.
  return `<span class="insights__unknown" data-tone="unknown">${escapeHtml(t("admin.insights.response.unknown"))}</span>`;
}

const ISSUE_COLUMNS = ["issue", "createdAt", "responseTime", "onTime"];

/** @param {string} key */
const colLabel = (key) => t(`admin.insights.siteIssues.col.${key}`);

/**
 * Below the rows: how many are shown, and Load more while the server has more.
 * @param {Reply} issues
 * @param {string} more "", "loading", or why the last Load more failed
 */
function moreView(issues, more) {
  const shown = /** @type {Reply[]} */ (issues.issues).length;
  const count =
    issues.total > shown
      ? `<p class="muted" data-issues-shown>${escapeHtml(t("admin.insights.issuesShown", { shown, count: issues.total }))}</p>`
      : "";
  const failed =
    more && more !== "loading"
      ? `<p class="error">${escapeHtml(more)}</p>`
      : "";
  const button = issues.nextCursor
    ? `<p><button type="button" class="btn-secondary" data-load-more ${more === "loading" ? "disabled" : ""}>${escapeHtml(t("admin.status.loadMore"))}</button></p>`
    : "";
  return `${count}${failed}${button}`;
}

/**
 * The Issues behind the selected tiles, or behind a concern.
 * @param {{ list: SiteList, issues: Reply | null, failed: string, tile: string, concern?: string, more?: string }} view
 */
export function siteIssuesView({
  list,
  issues,
  failed,
  tile,
  concern = "",
  more = "",
}) {
  if (!tile && !concern) return "";
  if (failed) return failedView(failed, SITE_LISTS[list].retry);
  if (!issues) return "";
  const rows = /** @type {Reply[]} */ (issues.issues);
  // No tile is picked, so a line says which Issues these are.
  const intro = concern
    ? `<p class="muted" data-concern-list="${escapeHtml(concern)}">${escapeHtml(t(`admin.insights.concernList.${concern}`, { days: CONCERN_RULES.unresolvedDays }))}</p>`
    : "";
  if (!rows.length)
    return `${intro}<p class="muted" data-site-issues-empty>${escapeHtml(t("admin.insights.noTileIssues"))}</p>`;
  const label = concern
    ? t(`admin.insights.concern.${concern}`)
    : tile
        .split(",")
        .map((key) => tileWord(list, key))
        .join(", ");
  return `${intro}<div class="table-wrap insights__table insights__table--paged" data-insights-table>
    <table role="table">
      <caption class="visually-hidden">${escapeHtml(label)}</caption>
      <thead role="rowgroup"><tr role="row">${ISSUE_COLUMNS.map((key) => `<th role="columnheader" scope="col">${escapeHtml(colLabel(key))}</th>`).join("")}</tr></thead>
      <tbody role="rowgroup">${rows
        .map((i) => {
          const band = severityBand(i.severity);
          // The space keeps the hidden severity word apart from the category when read aloud.
          return `<tr role="row" data-issue-row="${escapeHtml(i.issueId)}">
        <th role="rowheader" scope="row" data-label="${escapeHtml(colLabel("issue"))}"><span class="insights__sev" data-severity="${band}"><span class="insights__dot" aria-hidden="true"></span><span class="visually-hidden">${escapeHtml(t(`admin.insights.severity.${band}`))}</span></span> ${escapeHtml(i.category ? rulebookText(i.category, "rulebook.category") : t("admin.insights.issue.categoryUnknown"))}</th>
        <td role="cell" data-label="${escapeHtml(colLabel("createdAt"))}" data-issue-created>${escapeHtml(formatInstant(i.createdAt))}</td>
        <td role="cell" data-label="${escapeHtml(colLabel("responseTime"))}" data-issue-took>${responseTimeCell(i)}</td>
        <td role="cell" data-label="${escapeHtml(colLabel("onTime"))}" data-issue-on-time>${onTimeCell(i)}</td>
      </tr>`;
        })
        .join("")}</tbody>
    </table>
  </div>${moreView(issues, more)}`;
}
