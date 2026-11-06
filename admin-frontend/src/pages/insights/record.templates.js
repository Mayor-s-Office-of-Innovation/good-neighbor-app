// One Issue or Check record. The full record page and the side panel show the same body.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import {
  codeKey,
  failedView,
  failureText,
  formatInstant,
  helpTip,
  severityKnown,
  severityWord,
} from "./insights.templates.js";
import {
  categoryWord,
  checkStateWord,
  checkTime,
  dotView,
  issueRow,
  issueStateWord,
  openColumnHead,
  responseClass,
  responseWord,
  wordFor,
} from "./raw.templates.js";

/** @typedef {Record<string, any>} Row */
/** @typedef {"issue" | "check"} RecordKind */
/** @typedef {{ href: string, label: string }} Crumb */

/** @param {string} text */
const muted = (text) => `<span class="muted">${escapeHtml(text)}</span>`;

/** @param {Array<[string, string]>} rows label key under admin.insights.record, already-escaped value */
function facts(rows) {
  return `<dl class="insights__states">${rows
    .map(
      ([term, value]) =>
        `<div data-fact="${escapeHtml(term)}"><dt>${escapeHtml(t(`admin.insights.record.${term}`))}</dt><dd>${value}</dd></div>`,
    )
    .join("")}</dl>`;
}

/** @param {Row} issue */
export function severityText(issue) {
  return severityKnown(issue.severity)
    ? t("admin.insights.raw.severityLevel", {
        word: severityWord(issue.severity),
        level: issue.severity,
      })
    : severityWord(issue.severity);
}

/** A crumb's name for a record, e.g. "Unsecured gate" or "Check c1". @param {RecordKind} kind @param {Row | null} reply */
export function recordName(kind, reply) {
  if (!reply) return "";
  return kind === "issue"
    ? categoryWord(reply.issue.category)
    : t("admin.insights.check", { id: reply.check.checkId });
}

/**
 * "Raw data › Issues › [earlier records] › Unsecured gate". Each crumb jumps
 * to its level; from a Site page the trail starts there instead.
 * @param {{ root: Crumb, raw: string, fromSite: boolean, hops: Crumb[], current: string }} view
 * raw: the unfiltered list, for the "Raw data" crumb
 */
export function recordTrailView({ root, raw, fromSite, hops, current }) {
  const sep = '<span aria-hidden="true">›</span>';
  const items = [
    ...(fromSite
      ? []
      : [
          `<li><a href="${escapeHtml(raw)}" data-route data-crumb="raw">${escapeHtml(t("admin.insights.raw"))}</a></li>`,
        ]),
    `<li>${fromSite ? "" : sep}<a href="${escapeHtml(root.href)}" data-route data-crumb="root">${escapeHtml(root.label)}</a></li>`,
    ...hops.map(
      (hop, i) =>
        `<li>${sep}<a href="${escapeHtml(hop.href)}" data-route data-crumb="${i}">${escapeHtml(hop.label)}</a></li>`,
    ),
    `<li>${sep}<span aria-current="page">${escapeHtml(current)}</span></li>`,
  ];
  // Phones hide the trail, so a record opened from a shared link still has a way to its list.
  return `<nav class="entity-breadcrumb insights__trail" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}" data-record-trail><ol>${items.join("")}</ol></nav>
  <a class="site-back-link insights__trail-back" href="${escapeHtml(root.href)}" data-route data-crumb-back><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(root.label)}</a>`;
}

/**
 * "Check c1 › Issue t1" at the top of the panel, so an Issue opened from a
 * Check leads back to it.
 * @param {{ check: { id: string, siteId: string }, checkHref: string, issueId: string }} view
 */
export function panelTrailView({ check, checkHref, issueId }) {
  return `<nav class="entity-breadcrumb" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}" data-panel-trail><ol>
    <li><a href="${escapeHtml(checkHref)}" data-route data-panel-kind="check" data-panel-id="${escapeHtml(check.id)}" data-panel-site="${escapeHtml(check.siteId)}">${escapeHtml(t("admin.insights.check", { id: check.id }))}</a></li>
    <li><span aria-hidden="true">›</span><span aria-current="page">${escapeHtml(t("admin.insights.issue", { id: issueId }))}</span></li>
  </ol></nav>`;
}

/**
 * @param {{ kind: RecordKind, id: string, reply: Row | null, level: 1 | 2, siteHref: string }} view
 * level 1 on the full page; 2 in the panel, under the page's own heading;
 * siteHref "" names the Site without a link
 */
export function recordHeadView({ kind, id, reply, level, siteHref }) {
  const title = reply
    ? recordName(kind, reply)
    : t(`admin.insights.${kind}`, { id });
  const heading =
    level === 1
      ? `<h1 id="insights-title" tabindex="-1">${escapeHtml(title)}</h1>`
      : `<h2 id="insights-panel-title" tabindex="-1">${escapeHtml(title)}</h2>`;
  if (!reply) return `<div class="page-head">${heading}</div>`;
  const siteName = reply.site ? reply.site.name || reply.site.siteId : "";
  const site =
    reply.site && siteHref
      ? `<a href="${escapeHtml(siteHref)}" data-route data-record-site>${escapeHtml(siteName)}</a>`
      : escapeHtml(siteName);
  const parts =
    kind === "issue"
      ? [escapeHtml(t("admin.insights.issue", { id })), site]
      : [
          escapeHtml(
            wordFor(
              `admin.insights.raw.source.${reply.check.source}`,
              "admin.insights.raw.source.unknown",
            ),
          ),
          site,
          escapeHtml(
            reply.check.state === "completed"
              ? t("admin.insights.record.completedAt", {
                  time: formatInstant(
                    reply.check.completedAt ?? reply.check.activityAt,
                  ),
                })
              : checkTime(reply.check),
          ),
        ];
  return `<div class="page-head">${heading}</div>
  <p class="muted" data-record-meta>${parts.filter(Boolean).join(" · ")}</p>`;
}

/** @param {Row} issue @returns {[number, string, string][]} time, label key, instant */
function timeline(issue) {
  /** @type {[string, string | null][]} */
  const events = [
    ["created", issue.createdAt],
    ["firstResponse", issue.firstResponseAt],
    ["resolved", issue.resolvedAt],
  ];
  // Compared as instants, since one moment can be written with or without milliseconds.
  const shown = new Set(events.map(([, at]) => (at ? Date.parse(at) : NaN)));
  // Latest activity is only news when it isn't one of the moments above.
  if (issue.latestActivityAt && !shown.has(Date.parse(issue.latestActivityAt)))
    events.push(["latest", issue.latestActivityAt]);
  return events
    .filter(([, at]) => at && Number.isFinite(Date.parse(at)))
    .map(
      ([key, at]) =>
        /** @type {[number, string, string]} */ ([
          Date.parse(/** @type {string} */ (at)),
          key,
          /** @type {string} */ (at),
        ]),
    )
    .sort((a, b) => a[0] - b[0]);
}

/**
 * @param {{ reply: Row, checkHref: string, level: 2 | 3, idPrefix: string }} view
 * idPrefix keeps "?" ids apart when the panel and a page both hold one
 */
export function issueBodyView({ reply, checkHref, level, idPrefix }) {
  const issue = reply.issue;
  const check = reply.check;
  const h = `h${level}`;
  const parent = check
    ? `<a href="${escapeHtml(checkHref)}" data-route data-parent-check data-panel-kind="check" data-panel-id="${escapeHtml(check.checkId)}" data-panel-site="${escapeHtml(check.siteId)}">${escapeHtml(t("admin.insights.check", { id: check.checkId }))}</a> ${muted(`· ${checkTime(check)}`)}`
    : muted(
        t(
          issue.checkId
            ? "admin.insights.record.checkMissing"
            : "admin.insights.record.noCheck",
        ),
      );
  const state = escapeHtml(issueStateWord(issue));
  const firstResponse = issue.firstResponseAt
    ? escapeHtml(formatInstant(issue.firstResponseAt))
    : issue.responseState === "unknown"
      ? `<span class="insights__unknown">${escapeHtml(t("admin.insights.record.responseUnknown"))}</span>`
      : muted(t("admin.insights.record.noResponse"));
  const response = issue.responseState;
  const events = timeline(issue);
  return `${facts([
    [
      "status",
      issue.reopened
        ? `${state} ${muted(t("admin.insights.record.reopened"))}`
        : state,
    ],
    [
      "severity",
      `${dotView(issue.severity)} ${escapeHtml(severityText(issue))}`,
    ],
    ["parentCheck", parent],
  ])}
  <${h} id="${idPrefix}-response">${escapeHtml(t("admin.insights.record.response"))}${helpTip(`${idPrefix}-tip-response`, t("admin.insights.record.response"), t("admin.insights.record.responseHelp"))}</${h}>
  ${facts([
    ["created", escapeHtml(formatInstant(issue.createdAt))],
    [
      "deadline",
      issue.deadlineAt
        ? escapeHtml(formatInstant(issue.deadlineAt))
        : muted(t("admin.insights.record.noDeadline")),
    ],
    ["firstResponse", firstResponse],
    [
      "responseState",
      `<span data-response="${escapeHtml(response)}" class="${responseClass(response)}">${escapeHtml(responseWord(response))}</span>`,
    ],
    [
      "resolved",
      issue.resolvedAt
        ? escapeHtml(formatInstant(issue.resolvedAt))
        : muted(t("admin.insights.record.notResolved")),
    ],
  ])}
  <${h}>${escapeHtml(t("admin.insights.record.timeline"))}</${h}>
  <ol class="insights__timeline" data-timeline>${events
    .map(
      ([, key, at]) =>
        `<li data-event="${key}"><time datetime="${escapeHtml(at)}">${escapeHtml(formatInstant(at))}</time> ${escapeHtml(t(`admin.insights.record.event.${key}`))}</li>`,
    )
    .join("")}</ol>
  <${h}>${escapeHtml(t("admin.insights.record.actions"))}</${h}>
  ${facts([
    [
      "action",
      escapeHtml(
        wordFor(
          codeKey("admin.insights.record.action", issue.type ?? ""),
          "admin.insights.raw.notRecorded",
        ),
      ),
    ],
    [
      "updates",
      escapeHtml(
        t("admin.insights.record.updatesCount", {
          sightings: issue.sightings ?? 0,
          tasks: issue.followUpTasks ?? 0,
        }),
      ),
    ],
  ])}
  <section data-record-photos></section>`;
}

/** @param {{ reply: Row, issueHref: (issue: Row) => string, level: 2 | 3 }} view */
export function checkBodyView({ reply, issueHref, level }) {
  const check = reply.check;
  const issues = /** @type {Row[]} */ (reply.issues);
  const h = `h${level}`;
  return `${facts([
    [
      "recordedState",
      check.state === "completed"
        ? escapeHtml(checkStateWord(check))
        : `<span class="insights__unknown">${escapeHtml(checkStateWord(check))}</span>`,
    ],
    [
      "started",
      check.startedAt
        ? escapeHtml(formatInstant(check.startedAt))
        : muted(t("admin.insights.raw.notRecorded")),
    ],
    [
      "completed",
      check.completedAt
        ? escapeHtml(formatInstant(check.completedAt))
        : muted(t("admin.insights.record.notCompleted")),
    ],
  ])}
  <${h} data-check-issues-head>${escapeHtml(t("admin.insights.record.issuesFrom", { count: issues.length }))}</${h}>
  ${
    issues.length
      ? `<div class="table-wrap insights__table"><table role="table">
    <thead role="rowgroup"><tr role="row">${["category", "severity", "status", "response"].map((k) => `<th role="columnheader" scope="col">${escapeHtml(t(`admin.insights.raw.issue.${k}`))}</th>`).join("")}${openColumnHead()}</tr></thead>
    <tbody role="rowgroup">${issues
      .map((i) =>
        issueRow(i, issueHref, ["category", "severity", "status", "response"]),
      )
      .join("")}</tbody>
  </table></div>`
      : `<p class="muted" data-check-issues-empty>${escapeHtml(t("admin.insights.record.noIssues"))}</p>`
  }
  <section data-record-photos></section>`;
}

/**
 * Why a record didn't load. Not found, or found at two Sites, won't change on
 * a retry, so only other failures offer one.
 * @param {RecordKind} kind
 * @param {unknown} err
 * @param {string} [retryId]
 */
export function recordFailedView(kind, err, retryId) {
  const code = /** @type {any} */ (err)?.message;
  if (code === `${kind}_not_found` || code === "site_id_required")
    return `<p class="empty-state" data-insights-empty="${escapeHtml(code)}">${escapeHtml(t(`admin.insights.record.${code === "site_id_required" ? "needsSite" : "notFound"}.${kind}`))}</p>`;
  return failedView(
    failureText(err, t(`admin.insights.record.failed.${kind}`)),
    retryId,
  );
}

/**
 * The side panel. A native modal dialog, as the app's other dialogs are,
 * laid out at the right so the list stays in view.
 * @param {{ kind: RecordKind, full: Crumb }} view
 */
export function panelView({ kind, full }) {
  return `<dialog class="insights__panel" id="insights-panel" data-record-panel aria-label="${escapeHtml(t(`admin.insights.panel.${kind}`))}">
    <div class="insights__panel-bar">
      <a href="${escapeHtml(full.href)}" data-route id="insights-panel-full">${escapeHtml(full.label)}</a>
      <button type="button" class="btn-icon" id="insights-panel-close" aria-label="${escapeHtml(t("common.close"))}"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
    </div>
    <div data-panel-body></div>
  </dialog>`;
}
