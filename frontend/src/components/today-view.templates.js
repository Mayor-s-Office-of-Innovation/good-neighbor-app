/*
  Presentational templates for <today-view>, the home hub. Pure
  (data) → HTML string functions: state lives in today-view.js, which builds
  the view model, calls these, and wires the resulting DOM.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { HOME_TABS, formatOverdueElapsed } from "../domain/home-tasks.js";
import {
  analysisResultsTray,
  clearCheckCard,
  historicalCheckTitle,
  recentCheckTitle,
} from "./analysis-results.templates.js";
import { analysisDialogs } from "./perimeter-check.templates.js";

/* ---- Shell ---- */

/**
 * The whole home screen. `hero`, `capture`, `results`, and `dialogs` are
 * already-rendered markup strings from the templates below.
 * @param {{
 *   phaseClass: string,
 *   captureVisible: boolean,
 *   resultsInactive: boolean,
 *   settingsMenuOpen: boolean,
 *   hero: string,
 *   capture: string,
 *   results: string,
 *   showAnalysisDialogs: boolean,
 *   dialogs: string,
 *   logoutError: string,
 *   logoutPending: boolean,
 * }} vm
 * @returns {string}
 */
export function homeShell({
  phaseClass,
  captureVisible,
  resultsInactive,
  settingsMenuOpen,
  hero,
  capture,
  results,
  showAnalysisDialogs,
  dialogs,
  logoutError,
  logoutPending,
}) {
  return html`
    <div
      class="home ${phaseClass} ${captureVisible ? "home--has-capture" : ""}"
    >
      <section class="home-region home-region--header">
        <div class="home-top-actions">
          ${settingsMenu({ open: settingsMenuOpen })}
          <feedback-dialog class="feedback-dialog"></feedback-dialog>
        </div>
        <div class="screen screen--today-hero" role="group" aria-label="Today">
          ${hero}
        </div>
      </section>

      <section class="home-region home-region--capture" aria-live="polite">
        ${capture}
      </section>

      <section
        class="home-region home-region--results"
        aria-label="Task results"
        ${resultsInactive ? html`inert aria-hidden="true"` : ""}
      >
        ${results}
      </section>
      ${showAnalysisDialogs ? analysisDialogs() : ""} ${dialogs}
      ${logoutDialog({ error: logoutError, pending: logoutPending })}
    </div>
  `;
}

/** @param {{ open: boolean }} state */
export function settingsMenu({ open }) {
  return html`
    <div class="home-settings-wrap">
      <button
        class="home-settings"
        id="home-settings"
        type="button"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded="${open ? "true" : "false"}"
      >
        <span class="home-settings__icon" aria-hidden="true"></span>
      </button>
      ${open
        ? html`<div
            class="home-settings-menu"
            role="menu"
            aria-label="Settings"
          >
            <button id="settings-logout" type="button" role="menuitem">
              <wa-icon
                name="arrow-right-from-bracket"
                aria-hidden="true"
              ></wa-icon>
              Logout
            </button>
            <a
              href="https://docs.aws.amazon.com/location/latest/developerguide/data-attribution.html"
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              aria-label="Address data attribution (opens in a new tab)"
              >Address data attribution</a
            >
          </div>`
        : ""}
    </div>
  `;
}

/** @param {{ error: string, pending: boolean }} state */
export function logoutDialog({ error, pending }) {
  return html`
    <dialog
      class="places-modal logout-dialog"
      id="logout-dialog"
      aria-labelledby="logout-title"
      aria-describedby="logout-copy"
    >
      <form class="places-modal__card" method="dialog">
        <div class="places-modal__copy">
          <h2 class="places-modal__title" id="logout-title">
            Confirm you'd like to logout
          </h2>
          <p class="places-modal__text" id="logout-copy">
            This will log you out and unlink this device: you'll need to request
            a new code to access the app
          </p>
          ${error
            ? html`<p class="logout-dialog__error" role="alert">
                ${escapeHtml(error)}
              </p>`
            : ""}
        </div>
        <div class="places-modal__actions logout-dialog__actions">
          <button
            class="places-modal__primary logout-dialog__confirm"
            id="logout-confirm"
            type="button"
            ${pending ? "disabled" : ""}
          >
            ${pending ? "Logging out..." : "Log me out"}
          </button>
          <button class="logout-dialog__cancel" type="submit">
            Return to app
          </button>
        </div>
      </form>
    </dialog>
  `;
}

/** @param {{ flow: string | null }} state */
export function captureRegion({ flow }) {
  return html`
    <div class="home-capture">
      ${flow === "single-problem"
        ? html`<problem-report embedded></problem-report>`
        : html`<perimeter-check embedded></perimeter-check>`}
    </div>
  `;
}

/* ---- Hero: site identity, switcher, summary, CTAs ---- */

/**
 * @param {{ siteSwitcher: string, siteName: string, summary: string, checkLabel: string, reportLabel: string }} vm
 */
export function heroBlock({
  siteSwitcher,
  siteName,
  summary,
  checkLabel,
  reportLabel,
}) {
  return html`
    <div class="screen__sec home-lead">
      ${siteSwitcher}
      <div class="home-identity home-identity--with-summary">
        <h1 class="home-identity__site">${escapeHtml(siteName)}</h1>
        ${summary}
      </div>
      ${homeActions({ checkLabel, reportLabel })}
    </div>
  `;
}

/** @param {{ checkLabel: string, reportLabel: string }} labels */
export function homeActions({ checkLabel, reportLabel }) {
  return html`
    <div class="home-actions">
      <button id="start-check" class="btn-ink" type="button">
        ${escapeHtml(checkLabel)}
      </button>
      <button id="report-problem" class="btn-outline" type="button">
        ${escapeHtml(reportLabel)}
      </button>
    </div>
  `;
}

/**
 * @param {{
 *   providerName: string,
 *   sites: Array<{ siteId: string, name: string }>,
 *   currentSiteId: string,
 *   open: boolean,
 *   error: string,
 *   status: string,
 * }} vm
 */
export function siteSwitcher({
  providerName,
  sites,
  currentSiteId,
  open,
  error,
  status,
}) {
  return html`
    <div class="home-site-switcher">
      <button
        id="site-switcher-trigger"
        class="home-site-switcher__trigger"
        type="button"
        aria-expanded="${open ? "true" : "false"}"
        aria-controls="site-switcher-list"
      >
        <span>${escapeHtml(providerName || "Your provider")}</span>
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </button>
      ${open
        ? html`<div id="site-switcher-list" class="home-site-switcher__menu">
            ${sites
              .map(
                (site) =>
                  html`<button
                    class="home-site-switcher__item ${site.siteId ===
                    currentSiteId
                      ? "home-site-switcher__item--selected"
                      : ""}"
                    type="button"
                    data-switch-site="${escapeAttr(site.siteId)}"
                    ${site.siteId === currentSiteId
                      ? 'aria-current="page"'
                      : ""}
                  >
                    <span class="home-site-switcher__check" aria-hidden="true"
                      >${site.siteId === currentSiteId ? "✓" : ""}</span
                    >
                    <span>${escapeHtml(site.name)}</span>
                  </button>`,
              )
              .join("")}
            ${error
              ? html`<p class="home-site-switcher__error" role="alert">
                  ${escapeHtml(error)}
                </p>`
              : ""}
            ${status === "loading"
              ? html`<p class="home-site-switcher__status" role="status">
                  Loading sites…
                </p>`
              : ""}
            ${status === "error"
              ? html`<div class="home-site-switcher__failure">
                  <p role="alert">Other sites couldn't load.</p>
                  <button id="site-catalog-retry" type="button">Retry</button>
                </div>`
              : ""}
          </div>`
        : ""}
    </div>
  `;
}

/**
 * Last submitted check only: its recorded issue count and remaining actions,
 * or a nudge to switch sites when the device is not near this one.
 * @param {{ outsideRadius: boolean, label: string }} vm
 */
export function summaryBlock({ outsideRadius, label }) {
  if (outsideRadius) {
    return html`<div class="lastlog">
      <p class="lastlog__eyebrow">
        Looks like you're not near this site.
        <button
          id="lastlog-change-site"
          class="lastlog__switch"
          type="button"
          appearance="plain"
        >
          Change the site
        </button>
      </p>
    </div>`;
  }
  if (!label) return "";
  return html`
    <div class="lastlog">
      <p class="lastlog__eyebrow">${escapeHtml(label)}</p>
    </div>
  `;
}

/* ---- Results: trays, tabs, empty states ---- */

/**
 * @param {{
 *   homeFilter: string,
 *   siteName: string,
 *   siteAddress: string,
 *   pendingSessionId: string,
 *   hasPendingSession: boolean,
 *   recentCheckTime: string,
 *   recentItems: Array<object>,
 *   newTaskCards: Array<{ markup: string }>,
 *   newTaskCardsMarkup: string,
 *   newTaskCount: number,
 *   activeClearCheck: { submittedAt?: string, startedAt?: string } | null,
 *   hasPendingClearResult: boolean,
 *   historyGroups: Array<{ checkTime: string | Date, cards: string }>,
 * }} vm
 */
export function homeResults({
  homeFilter,
  siteName,
  siteAddress,
  pendingSessionId,
  hasPendingSession,
  recentCheckTime,
  recentItems,
  newTaskCards,
  newTaskCardsMarkup,
  newTaskCount,
  activeClearCheck,
  hasPendingClearResult,
  historyGroups,
}) {
  const hasVisibleCards =
    recentItems.length ||
    newTaskCount ||
    Boolean(activeClearCheck) ||
    historyGroups.length;
  const trayOptions = {
    id: "home-analysis-results",
    title: "",
    ariaLabel: "New analysis results",
    tone: "new",
    siteName,
    siteAddress,
    checkTime: recentCheckTime,
    extraCards: newTaskCards,
  };
  return html`
    <div class="home-results">
      ${hasPendingClearResult
        ? analysisResultsTray(recentItems, pendingSessionId, trayOptions)
        : activeClearCheck && !recentItems.length && !newTaskCount
          ? clearCheckTray(activeClearCheck, true)
          : ""}
      ${taskTabs({ activeId: homeFilter })}
      ${recentItems.length && !hasPendingClearResult
        ? analysisResultsTray(recentItems, pendingSessionId, trayOptions)
        : ""}
      ${newTaskCount && !recentItems.length
        ? newTaskTray({ cards: newTaskCardsMarkup, checkTime: recentCheckTime })
        : ""}
      ${historyGroups.length
        ? html`
            <div class="home-results__cards">
              ${historyGroups.map((group) => historyTray(group)).join("")}
            </div>
          `
        : ""}
      ${!hasVisibleCards
        ? homeFilter === "todo" && !hasPendingSession
          ? homeAllDonePanel()
          : emptyResults({ homeFilter })
        : ""}
    </div>
  `;
}

/** @param {{ cards: string, checkTime: string }} vm */
export function newTaskTray({ cards, checkTime }) {
  return html`
    <section
      class="analysis-tray analysis-tray--new analysis-tray--recent"
      aria-label="New analysis results"
    >
      <div class="analysis-tray__cards">
        <h2 class="analysis-tray__check-title">
          ${escapeHtml(recentCheckTitle(checkTime))}
        </h2>
        ${cards}
      </div>
    </section>
  `;
}

/**
 * @param {{ submittedAt?: string, startedAt?: string }} check
 * @param {boolean} [recent]
 */
export function clearCheckTray(check, recent = false) {
  const checkTime = check.submittedAt || check.startedAt || "";
  const title = recent
    ? recentCheckTitle(checkTime)
    : historicalCheckTitle(checkTime);
  return html`
    <section
      class="analysis-tray ${recent
        ? "analysis-tray--new analysis-tray--recent"
        : "analysis-tray--history"}"
      aria-label="${escapeAttr(title)}"
    >
      <div class="analysis-tray__cards">
        <h2 class="analysis-tray__check-title">${escapeHtml(title)}</h2>
        ${clearCheckCard()}
      </div>
    </section>
  `;
}

/**
 * One past check's tray: its task cards, or the clear-check card when the
 * check found nothing.
 * @param {{ checkTime: string | Date, cards: string }} group
 */
export function historyTray({ checkTime, cards }) {
  return html`
    <section
      class="analysis-tray analysis-tray--history"
      aria-label="${escapeAttr(historicalCheckTitle(checkTime))}"
    >
      <div class="analysis-tray__cards">
        <h2 class="analysis-tray__check-title">
          ${escapeHtml(historicalCheckTitle(checkTime))}
        </h2>
        ${cards || clearCheckCard()}
      </div>
    </section>
  `;
}

/** @param {{ activeId: string, tabs?: Array<{ id: string, label: string }> }} vm */
export function taskTabs({ activeId, tabs = HOME_TABS }) {
  return html`
    <div class="home-tabs" role="group" aria-label="Filter tasks">
      ${tabs
        .map(
          (tab) => html`
            <button
              class="home-tabs__tab ${tab.id === activeId
                ? "home-tabs__tab--active"
                : ""}"
              type="button"
              aria-pressed="${tab.id === activeId ? "true" : "false"}"
              data-home-filter="${escapeAttr(tab.id)}"
            >
              ${escapeHtml(tab.label)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

/** @param {{ homeFilter: string }} vm */
export function emptyResults({ homeFilter }) {
  return html`<p class="home-results__empty" role="status">
    ${homeFilter === "todo"
      ? "No tasks to do."
      : homeFilter === "in_progress"
        ? "No tasks in progress."
        : "No task history yet."}
  </p>`;
}

/** @returns {string} */
export function homeAllDonePanel() {
  return html`
    <section
      class="home-results__complete"
      aria-labelledby="home-all-done-title"
    >
      <div class="home-results__complete-content">
        <img src="/clear-check-icon.png" alt="" width="96" height="98" />
        <h2 id="home-all-done-title">All done!</h2>
        <p>
          Your site is in great shape. Nothing needs your attention right now.
        </p>
        <p class="home-results__complete-note">
          <a href="/problem" data-start-capture="single-problem">
            Add a problem
          </a>
          if we missed something.
        </p>
      </div>
    </section>
  `;
}

/* ---- Card action controls ---- */

/**
 * @param {{ kind: string, label: string, variant: string, href?: string | null }} a
 */
export function actionButton(a) {
  const cls =
    a.variant === "ink"
      ? "btn-ink btn-ink--sm"
      : a.variant === "blue"
        ? "btn-blue btn-blue--sm"
        : "btn-outline btn-outline--sm";
  // Link-style actions render as native anchors with no data-action, so the
  // click wiring skips them and the browser handles the URL.
  if (a.href) {
    return html`<a class="${cls}" href="${escapeAttr(a.href)}"
      >${escapeHtml(a.label)}</a
    >`;
  }
  // An email whose target isn't known yet: surface the instruction but keep
  // it non-interactive rather than misdialing or opening an empty composer.
  if (a.kind === "email") {
    return html`<button type="button" class="${cls}" disabled>
      ${escapeHtml(a.label)}
    </button>`;
  }
  return html`<button type="button" class="${cls}" data-action="${a.kind}">
    ${escapeHtml(a.label)}
  </button>`;
}

/**
 * "Can't" → the task's allowlisted reasons (the backend rejects arbitrary
 * ones), plus a cancel.
 * @param {{ reasons: string[] }} vm
 */
export function reasonPicker({ reasons }) {
  return html`
    ${reasons
      .map(
        (r) =>
          html`<button
            type="button"
            class="btn-outline btn-outline--sm"
            data-action="cant-reason"
            data-reason="${escapeHtml(r)}"
          >
            ${escapeHtml(r)}
          </button>`,
      )
      .join("")}
    <button
      type="button"
      class="home-cta__link actioncard__cancel"
      data-action="cant-cancel"
    >
      Cancel
    </button>
  `;
}

/* ---- Dialogs ---- */

/**
 * @param {{
 *   siteName: string,
 *   sites: Array<{ siteId: string, name: string }>,
 *   currentSiteId: string,
 * }} vm
 */
export function locationDialog({ siteName, sites, currentSiteId }) {
  return html`<dialog
    class="location-dialog"
    id="location-dialog"
    aria-labelledby="location-dialog-title"
    aria-describedby="location-dialog-copy"
  >
    <div class="location-dialog__card">
      <div class="location-dialog__copy">
        <h2 id="location-dialog-title">
          Is your app set to the right location?
        </h2>
        <p id="location-dialog-copy">
          It looks like you're not near ${escapeHtml(siteName)}. Consider
          changing your app's site.
        </p>
      </div>
      <div
        class="location-dialog__sites"
        role="group"
        aria-label="Choose a site"
      >
        ${sites
          .map(
            (site) =>
              html`<button
                class="home-site-switcher__item location-dialog__site"
                appearance="plain"
                type="button"
                data-location-site="${escapeAttr(site.siteId)}"
                aria-pressed="${site.siteId === currentSiteId
                  ? "true"
                  : "false"}"
              >
                <span class="home-site-switcher__check" aria-hidden="true"
                  >${site.siteId === currentSiteId ? "✓" : ""}</span
                >
                <span>${escapeHtml(site.name)}</span>
              </button>`,
          )
          .join("")}
      </div>
      <div class="location-dialog__actions">
        <button
          class="location-dialog__confirm"
          appearance="plain"
          id="location-confirm"
          type="button"
          disabled
        >
          Confirm site change
        </button>
        <button
          class="location-dialog__stay"
          appearance="plain"
          id="location-stay"
          type="button"
        >
          I'm in the right location
        </button>
      </div>
    </div>
  </dialog>`;
}

function formatTicketDate(date) {
  return date
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(date))
    : "";
}

function formatTicketRelativeDate(date) {
  if (!date) return "";
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000),
  );
  return days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

function ticketEventDescription(description) {
  return description ? html`<p>${escapeHtml(description)}</p>` : "";
}

/**
 * The 311 request detail sheet. `state` drives the loading / error rows;
 * `detail` is the loaded request (null until it arrives).
 * @param {{ detail: any, state: string }} vm — state is "idle" | "loading" | "ready" | "error"
 */
export function ticketDetailDialog({ detail, state }) {
  return html` <dialog
    class="ticket-detail"
    id="ticket-detail-dialog"
    aria-labelledby="ticket-detail-title"
  >
    <div class="ticket-detail__sheet">
      <header class="ticket-detail__header">
        <button
          type="button"
          class="btn-icon ticket-detail__close wa-plain"
          data-close-311
          aria-label="Close request details"
        >
          <wa-icon name="xmark" aria-hidden="true"></wa-icon>
        </button>
      </header>
      ${state === "loading"
        ? html`<p role="status">Loading request updates…</p>`
        : ""}
      ${state === "error"
        ? html`<div role="alert">
            <p>We couldn't load the latest 311 updates.</p>
            <button
              type="button"
              class="btn-outline btn-outline--sm"
              data-retry-311
            >
              Try again
            </button>
          </div>`
        : ""}
      ${detail
        ? html` <section
              class="ticket-detail__summary"
              aria-label="Request summary"
            >
              <p
                class="ticket-detail__type ticket-detail__type--${detail.responseOverdue
                  ? "overdue"
                  : detail.status === "Closed"
                    ? "closed"
                    : "default"}"
              >
                <span aria-hidden="true"></span>
                <span class="ticket-detail__type-label">311 request</span>
                <span class="ticket-detail__type-separator" aria-hidden="true"
                  >·</span
                >
                <strong
                  >${escapeHtml(detail.status)}${detail.statusDetail
                    ? html`: ${escapeHtml(detail.statusDetail)}`
                    : ""}</strong
                >
              </p>
              ${detail.location
                ? html`<p class="ticket-detail__location">
                    ${escapeHtml(String(detail.location).split(/\r?\n|,/)[0])}
                  </p>`
                : ""}
              <h2 id="ticket-detail-title">
                ${escapeHtml(
                  detail.title || detail.problemType || "Request details",
                )}
              </h2>
              ${detail.description
                ? html`<p class="ticket-detail__description">
                    ${escapeHtml(detail.description)}
                  </p>`
                : ""}
              ${detail.mediaUrl
                ? html`<img
                    class="ticket-detail__photo"
                    src="${escapeAttr(detail.mediaUrl)}"
                    alt="Evidence for ${escapeAttr(
                      detail.title || detail.problemType || "the 311 request",
                    )}"
                  />`
                : html`<div
                    class="ticket-detail__photo photo-placeholder"
                    role="img"
                    aria-label="No photo available"
                  >
                    <wa-icon name="image" aria-hidden="true"></wa-icon>
                  </div>`}
              <dl class="ticket-detail__metadata">
                ${detail.assignedAgency
                  ? html`<div>
                      <dt>Agency:</dt>
                      <dd>${escapeHtml(detail.assignedAgency)}</dd>
                    </div>`
                  : ""}
                ${detail.submittedAt
                  ? html`<div>
                      <dt>Submitted:</dt>
                      <dd>
                        ${escapeHtml(
                          formatTicketRelativeDate(detail.submittedAt),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.expectedResponseAt
                  ? html`<div>
                      <dt>Response expected:</dt>
                      <dd>
                        ${escapeHtml(
                          formatTicketDate(detail.expectedResponseAt),
                        )}
                      </dd>
                    </div>`
                  : ""}
                ${detail.closureReason
                  ? html`<div>
                      <dt>Closure reason:</dt>
                      <dd>${escapeHtml(detail.closureReason)}</dd>
                    </div>`
                  : ""}
              </dl>
              ${detail.responseOverdue && detail.expectedResponseAt
                ? html`<p class="ticket-detail__overdue-message">
                    The City's expected response time passed
                    ${escapeHtml(
                      formatOverdueElapsed(detail.expectedResponseAt),
                    )}
                    ago.
                  </p>`
                : ""}
            </section>
            <section class="ticket-detail__updates">
              <h3>Request updates</h3>
              ${detail.events?.length
                ? html`<ol class="ticket-timeline">
                    ${detail.events
                      .map(
                        (event) =>
                          html`<li class="ticket-timeline__item">
                            <div class="ticket-timeline__content">
                              <strong>${escapeHtml(event.title)}</strong
                              >${ticketEventDescription(event.description)}
                              <time datetime="${escapeAttr(event.occurredAt)}"
                                >${escapeHtml(
                                  formatTicketDate(event.occurredAt),
                                )}</time
                              >
                            </div>
                          </li>`,
                      )
                      .join("")}
                  </ol>`
                : html`<p>No updates are available yet.</p>`}
            </section>
            <p class="ticket-detail__reference">
              #${escapeHtml(detail.requestNumber)}
            </p>`
        : ""}
    </div>
  </dialog>`;
}

/* ---- Error view ---- */

/**
 * Backend unreachable on load: identity, a plain status, and a retry.
 * @param {{ identity: { org: string, site: string } }} vm
 */
export function errorView({ identity }) {
  return html`
    <div class="home">
      <div class="screen" role="group" aria-label="Today">
        <div class="screen__sec home-lead">
          <div class="home-identity">
            ${identity.org
              ? html`<p class="home-identity__org">
                  ${escapeHtml(identity.org)}
                </p>`
              : ""}
            <h1 class="home-identity__site">${escapeHtml(identity.site)}</h1>
          </div>
          <div class="lastlog">
            <p class="lastlog__eyebrow">CAN’T REACH THE SERVER</p>
            <p class="lastlog__summary">Checks are unavailable</p>
          </div>
          <div class="home-actions">
            <button id="retry" class="btn-ink" type="button">Try again</button>
          </div>
        </div>
      </div>
    </div>
  `;
}
