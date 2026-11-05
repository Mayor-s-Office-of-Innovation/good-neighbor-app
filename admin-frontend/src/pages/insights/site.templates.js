// Site insights markup: Activity, Response and contacts, and the Issues created in the period.
import { hasKey, t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { rulebookText } from "../../../../frontend/src/i18n/rulebook.js";
import {
  codeKey,
  contactWord,
  failedView,
  formatDay,
  formatInstant,
  noDataFor,
  severityWord,
} from "./insights.templates.js";

/** @typedef {Record<string, any>} Reply */

const ACTIVITY = [
  "completedPerimeterChecks",
  "singleIssueReports",
  "issuesCreated",
  "unfinishedChecks",
];
const RESPONSE = [
  "overdue",
  "late",
  "awaiting",
  "onTime",
  "unknown",
  "notTimed",
];

/** @param {{ site: Reply | null, siteId: string, names: Map<string, string> }} view */
export function siteHeadView({ site, siteId, names }) {
  const meta = site
    ? [
        site.department &&
          t("admin.insights.siteMeta.department", { name: site.department }),
        site.managerId &&
          t("admin.insights.siteMeta.manager", {
            name: names.get(site.managerId) ?? site.managerId,
          }),
        site.status === "inactive" && t("admin.insights.inactive"),
      ].filter((part) => typeof part === "string")
    : [];
  return `<div class="page-head"><h1 id="insights-title" tabindex="-1">${escapeHtml(site?.name || (site ? siteId : t("admin.insights.site")))}</h1></div>${
    meta.length
      ? `<p class="muted" data-site-meta>${meta.map((m) => escapeHtml(m)).join(" · ")}</p>`
      : ""
  }`;
}

/** @param {{ back: string, manage: string, raw: string }} links */
export function siteLinksView({ back, manage, raw }) {
  return `<p class="insights__links">
    <a class="site-back-link" id="insights-back" href="${escapeHtml(back)}" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.insights.backToOverview"))}</a>
    <a class="btn-secondary" id="insights-manage-site" href="${escapeHtml(manage)}" data-route>${escapeHtml(t("admin.insights.manageSite"))}</a>
    <a class="btn-link" id="insights-site-raw" href="${escapeHtml(raw)}" data-route>${escapeHtml(t("admin.insights.seeAllIssues"))}</a>
  </p>`;
}

/** @param {Reply} reply */
function activityView(reply) {
  const counts = reply.totals.activity;
  const days = /** @type {Reply[]} */ (reply.days);
  return `<section class="insights__group" aria-labelledby="insights-activity">
    <h2 id="insights-activity">${escapeHtml(t("admin.insights.activity"))}</h2>
    <dl class="insights__tiles">${ACTIVITY.map(
      (key) =>
        `<div data-activity="${key}"><dt>${escapeHtml(t(`admin.insights.activity.${key}`))}</dt><dd class="insights__num">${escapeHtml(counts[key] ?? 0)}</dd></div>`,
    ).join("")}</dl>
    <p class="muted">${escapeHtml(t("admin.insights.activity.help"))}</p>
    ${
      days.length
        ? `<details class="table-disclosure" data-site-days>
      <summary>${escapeHtml(t("admin.insights.daily"))}</summary>
      <div class="table-wrap"><table>
        <thead><tr><th scope="col">${escapeHtml(t("admin.insights.daily.day"))}</th><th scope="col" class="insights__num">${escapeHtml(t("admin.insights.col.checks"))}</th><th scope="col" class="insights__num">${escapeHtml(t("admin.insights.activity.issuesCreated"))}</th></tr></thead>
        <tbody>${days
          .map(
            (d) =>
              `<tr><th scope="row">${escapeHtml(formatDay(d.day))}</th><td class="insights__num">${escapeHtml(d.completedPerimeterChecks)}</td><td class="insights__num">${escapeHtml(d.issuesCreated)}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>
    </details>`
        : ""
    }
  </section>`;
}

/** @param {string} label @param {{ state: string, reasonCodes: string[] }} contact @param {string} kind */
function contactView(label, contact, kind) {
  // A reason added on the server later shows the state alone, not a key.
  const reasons = contact.reasonCodes
    .map((code) => codeKey("admin.insights.reason", code))
    .filter((key) => hasKey(key))
    .map((key) => t(key));
  return `<div data-contact="${kind}"><dt>${escapeHtml(label)}</dt><dd><strong>${escapeHtml(contactWord(contact))}</strong>${
    reasons.length
      ? `<span class="muted"> ${reasons.map((r) => escapeHtml(r)).join(" ")}</span>`
      : ""
  }</dd></div>`;
}

/** @param {Reply} reply @param {string} contactsHref */
function responseView(reply, contactsHref) {
  const counts = reply.totals.response;
  return `<section class="insights__group" aria-labelledby="insights-response">
    <h2 id="insights-response">${escapeHtml(t("admin.insights.responseContacts"))}</h2>
    <dl class="insights__states">${RESPONSE.map(
      (key) =>
        `<div data-response="${key}"><dt>${escapeHtml(t(`admin.insights.response.${key}`))}</dt><dd><span class="insights__num" data-response-count>${escapeHtml(counts[key] ?? 0)}</span> <span class="muted">${escapeHtml(t(`admin.insights.responseHelp.${key}`))}</span></dd></div>`,
    ).join("")}</dl>
    <p class="muted">${escapeHtml(t("admin.insights.deadlineNote"))}</p>
    <dl class="insights__states">
      ${contactView(t("admin.insights.col.publicContact"), reply.publicContact, "public")}
      ${contactView(t("admin.insights.col.siteContact"), reply.siteContact, "site")}
    </dl>
    <p class="muted">${escapeHtml(t("admin.insights.contactBasis"))} <a href="${escapeHtml(contactsHref)}" data-route id="insights-edit-contacts">${escapeHtml(t("admin.insights.editContacts"))}</a></p>
  </section>`;
}

/** @param {{ reply: Reply, contactsHref: string }} view */
export function siteBodyView({ reply, contactsHref }) {
  return `${activityView(reply)}${responseView(reply, contactsHref)}`;
}

/** @param {{ issues: Reply | null, failed: string, issueHref: (issue: Reply) => string }} view */
export function siteIssuesView({ issues, failed, issueHref }) {
  const heading = `<h2 id="insights-site-issues" tabindex="-1">${escapeHtml(t("admin.insights.issuesInPeriod"))}</h2>`;
  if (failed) return `${heading}${failedView(failed, "insights-issues-retry")}`;
  if (!issues) return heading;
  const rows = /** @type {Reply[]} */ (issues.issues);
  // Before the records begin, an empty list isn't a quiet period.
  if (!rows.length)
    return `${heading}<p class="muted" data-site-issues-empty>${escapeHtml(t(noDataFor(issues.meta) ? "admin.insights.empty.noIssueData" : "admin.insights.noIssuesInPeriod"))}</p>`;
  const col = (/** @type {string} */ key) =>
    `<th role="columnheader" scope="col">${escapeHtml(t(`admin.insights.issue.${key}`))}</th>`;
  return `${heading}
    <div class="table-wrap insights__table"><table role="table">
      <thead role="rowgroup"><tr role="row">${["created", "category", "severity", "status", "response", "deadline"].map(col).join("")}</tr></thead>
      <tbody role="rowgroup">${rows
        .map(
          (i) => `<tr role="row" data-issue-row="${escapeHtml(i.issueId)}">
        <th role="rowheader" scope="row" data-label="${escapeHtml(t("admin.insights.issue.created"))}"><a href="${escapeHtml(issueHref(i))}" data-route>${escapeHtml(formatInstant(i.createdAt))}</a></th>
        <td role="cell" data-label="${escapeHtml(t("admin.insights.issue.category"))}">${escapeHtml(i.category ? rulebookText(i.category, "rulebook.category") : t("admin.insights.issue.categoryUnknown"))}</td>
        <td role="cell" data-label="${escapeHtml(t("admin.insights.issue.severity"))}">${escapeHtml(severityWord(i.severity))}</td>
        <td role="cell" data-label="${escapeHtml(t("admin.insights.issue.status"))}">${escapeHtml(t(`admin.insights.issueStatus.${i.resolvedAt ? "resolved" : "open"}`))}</td>
        <td role="cell" data-label="${escapeHtml(t("admin.insights.issue.response"))}" data-response="${escapeHtml(i.responseState)}">${escapeHtml(t(`admin.insights.response.${i.responseState}`))}</td>
        <td role="cell" data-label="${escapeHtml(t("admin.insights.issue.deadline"))}">${escapeHtml(formatInstant(i.deadlineAt))}</td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>
    ${
      issues.total > rows.length
        ? `<p class="muted">${escapeHtml(t("admin.insights.issuesShown", { shown: rows.length, count: issues.total }))}</p>`
        : ""
    }`;
}
