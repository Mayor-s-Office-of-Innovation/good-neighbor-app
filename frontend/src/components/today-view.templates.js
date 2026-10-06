/*
  Presentational templates for <today-view>, the home hub. Pure
  (data) → HTML string functions: state lives in today-view.js, which builds
  the view model, calls these, and wires the resulting DOM.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { HOME_TABS } from "../domain/home-tasks.js";
import { getLocale, LOCALES, t } from "../i18n/i18n.js";
import {
  analysisResultsTray,
  clearCheckCard,
  historicalCheckTitle,
  recentCheckTitle,
} from "./analysis-results.templates.js";
import { analysisDialogs } from "./analysis-results.templates.js";

/* ---- Shell ---- */

/**
 * The whole home screen. `hero` and `results` are already-rendered markup
 * strings from the templates below. Capture lives on its own route
 * (/check, /problem) — the home screen has no capture region anymore. The
 * <location-dialog> placeholder is replaced by the host's persistent element
 * after render.
 * @param {{
 *   settingsMenuOpen: boolean,
 *   adminAccess: boolean,
 *   hero: string,
 *   results: string,
 *   showAnalysisDialogs: boolean,
 *   logoutError: string,
 *   logoutPending: boolean,
 * }} vm
 * @returns {string}
 */
export function homeShell({
  settingsMenuOpen,
  adminAccess,
  hero,
  results,
  showAnalysisDialogs,
  logoutError,
  logoutPending,
}) {
  return html`
    <div class="home">
      <section class="home-region home-region--header">
        <div class="home-top-actions">
          ${settingsMenu({ open: settingsMenuOpen, adminAccess })}
          <feedback-dialog
            class="feedback-dialog"
            hide-trigger
          ></feedback-dialog>
        </div>
        <div
          class="screen screen--today-hero"
          role="group"
          aria-label="${escapeAttr(t("today.hero.aria"))}"
        >
          ${hero}
        </div>
      </section>

      <section
        class="home-region home-region--results"
        aria-label="${escapeAttr(t("today.results.aria"))}"
      >
        ${results}
      </section>
      ${showAnalysisDialogs ? analysisDialogs() : ""}
      <location-dialog></location-dialog>
      ${attributionDialog()} ${languageDialog()}
      ${logoutDialog({ error: logoutError, pending: logoutPending })}
    </div>
  `;
}

/** @param {{ open: boolean, adminAccess?: boolean }} state */
export function settingsMenu({ open, adminAccess = false }) {
  return html`
    <div class="home-settings-wrap">
      <button
        class="home-settings"
        id="home-settings"
        type="button"
        aria-label="${escapeAttr(t("today.settings.aria"))}"
        aria-haspopup="menu"
        aria-expanded="${open ? "true" : "false"}"
      >
        <span class="home-settings__icon" aria-hidden="true"></span>
      </button>
      ${open
        ? html`<div
            class="home-settings-menu"
            role="menu"
            aria-label="${escapeAttr(t("today.settings.aria"))}"
          >
            <button id="settings-feedback" type="button" role="menuitem">
              <wa-icon name="comment" aria-hidden="true"></wa-icon>
              ${escapeHtml(t("today.settings.feedback"))}
            </button>
            ${adminAccess
              ? html`<button
                  id="settings-site-admin"
                  type="button"
                  role="menuitem"
                >
                  <wa-icon name="location-dot" aria-hidden="true"></wa-icon>
                  ${escapeHtml(t("today.settings.siteAdmin"))}
                </button>`
              : ""}
            <button id="settings-language" type="button" role="menuitem">
              <wa-icon name="language" aria-hidden="true"></wa-icon>
              ${escapeHtml(t("today.settings.language"))}
            </button>
            <button id="settings-attributions" type="button" role="menuitem">
              <wa-icon name="file-lines" aria-hidden="true"></wa-icon>
              ${escapeHtml(t("today.settings.attributions"))}
            </button>
            <button id="settings-logout" type="button" role="menuitem">
              <wa-icon
                name="arrow-right-from-bracket"
                aria-hidden="true"
              ></wa-icon>
              ${escapeHtml(t("today.settings.logout"))}
            </button>
          </div>`
        : ""}
    </div>
  `;
}

export function attributionDialog() {
  return html`<dialog
    class="places-modal attributions-dialog"
    id="attributions-dialog"
    aria-labelledby="attributions-title"
    aria-describedby="attributions-copy"
  >
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="attributions-title">
          ${escapeHtml(t("today.attributions.title"))}
        </h2>
        <p class="places-modal__text" id="attributions-copy">
          ${escapeHtml(t("today.attributions.text"))}
        </p>
        <ul class="attributions-list">
          <li>
            <a
              href="https://docs.aws.amazon.com/location/latest/developerguide/data-attribution.html"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="${escapeAttr(
                t("common.opensNewTab", {
                  label: t("today.attributions.aws"),
                }),
              )}"
            >
              ${escapeHtml(t("today.attributions.aws"))}
            </a>
          </li>
          <li>
            <a
              href="https://geocoding.geo.census.gov/geocoder/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="${escapeAttr(
                t("common.opensNewTab", {
                  label: t("today.attributions.census"),
                }),
              )}"
            >
              ${escapeHtml(t("today.attributions.census"))}
            </a>
          </li>
        </ul>
      </div>
      <div class="places-modal__actions">
        <button class="btn-ink places-modal__primary" type="submit">
          ${escapeHtml(t("common.close"))}
        </button>
      </div>
    </form>
  </dialog>`;
}

/**
 * Language picker. Each option is a submit button whose value is the locale
 * id; the host reads dialog.returnValue on close and calls setLocale. The
 * current language is marked with aria-current; choosing it is a no-op.
 */
export function languageDialog() {
  const current = getLocale();
  return html`<dialog
    class="places-modal language-dialog"
    id="language-dialog"
    aria-labelledby="language-title"
    aria-describedby="language-copy"
  >
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="language-title">
          ${escapeHtml(t("today.language.title"))}
        </h2>
        <p class="places-modal__text" id="language-copy">
          ${escapeHtml(t("today.language.text"))}
        </p>
        <ul class="language-list" data-testid="language-options">
          ${LOCALES.map(
            (locale) =>
              html`<li>
                <button
                  class="language-list__option"
                  type="submit"
                  value="${escapeAttr(locale.id)}"
                  lang="${escapeAttr(locale.tag)}"
                  data-locale="${escapeAttr(locale.id)}"
                  ${locale.id === current ? 'aria-current="true"' : ""}
                >
                  ${escapeHtml(locale.label)}
                </button>
              </li>`,
          ).join("")}
        </ul>
      </div>
      <div class="places-modal__actions">
        <button class="btn-ink places-modal__primary" type="submit" value="">
          ${escapeHtml(t("common.close"))}
        </button>
      </div>
    </form>
  </dialog>`;
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
            ${escapeHtml(t("today.logout.title"))}
          </h2>
          <p class="places-modal__text" id="logout-copy">
            ${escapeHtml(t("today.logout.text"))}
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
            ${escapeHtml(
              pending ? t("today.logout.pending") : t("today.logout.confirm"),
            )}
          </button>
          <button class="logout-dialog__cancel" type="submit">
            ${escapeHtml(t("today.logout.cancel"))}
          </button>
        </div>
      </form>
    </dialog>
  `;
}

/* ---- Hero: site identity, switcher, summary, CTAs ---- */

/**
 * The <site-switcher> placeholder is replaced by the host's persistent
 * element after render (see today-view._mountSiteSwitcher).
 * @param {{ siteName: string, summary: string, checkLabel: string, reportLabel: string }} vm
 */
export function heroBlock({ siteName, summary, checkLabel, reportLabel }) {
  return html`
    <div class="screen__sec home-lead">
      <site-switcher></site-switcher>
      <div class="home-identity home-identity--with-summary">
        <h1 class="home-identity__site" tabindex="-1">
          ${escapeHtml(siteName)}
        </h1>
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
 * Last submitted check only: its recorded issue count and remaining actions,
 * or a nudge to switch sites when the device is not near this one.
 * @param {{ outsideRadius: boolean, label: string }} vm
 */
export function summaryBlock({ outsideRadius, label }) {
  if (outsideRadius) {
    return html`<div class="lastlog">
      <p class="lastlog__eyebrow">
        ${escapeHtml(t("today.summary.outsideRadius"))}
        <button
          id="lastlog-change-site"
          class="lastlog__switch"
          type="button"
          appearance="plain"
          data-opens-site-switcher
        >
          ${escapeHtml(t("today.summary.changeSite"))}
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
 *   historyGrouping?: string,
 *   historyGroups: Array<{ checkTime: string | Date, cards: string, title?: string, compact?: boolean }>,
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
  historyGrouping = "resolved",
}) {
  const hasVisibleCards =
    recentItems.length ||
    newTaskCount ||
    Boolean(activeClearCheck) ||
    historyGroups.length;
  const trayOptions = {
    id: "home-analysis-results",
    title: "",
    ariaLabel: t("today.newResults.aria"),
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
      ${homeFilter === "history"
        ? html`<div class="history-grouping">
            <span id="history-group-label"
              >${escapeHtml(t("card.history.groupBy"))}</span
            ><wa-select
              id="history-grouping"
              label="${escapeAttr(t("card.history.groupBy"))}"
              value="${escapeAttr(historyGrouping)}"
              >${["resolved", "opened", "type"]
                .map(
                  (value) =>
                    html`<wa-option value="${value}"
                      >${escapeHtml(
                        t(`card.history.group.${value}`),
                      )}</wa-option
                    >`,
                )
                .join("")}</wa-select
            >
          </div>`
        : ""}
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
      aria-label="${escapeAttr(t("today.newResults.aria"))}"
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
 * @param {{ checkTime: string | Date, cards: string, title?: string, compact?: boolean }} group
 */
export function historyTray({ checkTime, cards, title = "", compact = false }) {
  return html`
    <section
      class="analysis-tray analysis-tray--history ${compact
        ? "analysis-tray--compact"
        : ""}"
      aria-label="${escapeAttr(title || historicalCheckTitle(checkTime))}"
    >
      <div class="analysis-tray__cards">
        <h2 class="analysis-tray__check-title">
          ${escapeHtml(title || historicalCheckTitle(checkTime))}
        </h2>
        ${compact
          ? html`<div class="history-card-list">${cards}</div>`
          : cards || clearCheckCard()}
      </div>
    </section>
  `;
}

/** @param {{ activeId: string, tabs?: Array<{ id: string, labelKey: string }> }} vm */
export function taskTabs({ activeId, tabs = HOME_TABS }) {
  return html`
    <div
      class="home-tabs"
      role="group"
      aria-label="${escapeAttr(t("today.tabs.aria"))}"
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
              data-home-filter="${escapeAttr(tab.id)}"
            >
              ${escapeHtml(t(tab.labelKey))}
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
    ${escapeHtml(
      homeFilter === "todo"
        ? t("today.empty.todo")
        : homeFilter === "in_progress"
          ? t("today.empty.inProgress")
          : t("today.empty.history"),
    )}
  </p>`;
}

/** @returns {string} */
export function homeAllDonePanel() {
  // The note is one sentence whose {link} slot holds the single-issue anchor;
  // escape the sentence first, then drop the trusted markup into the slot.
  const addProblem = html`<a href="/problem" data-start-capture="single-problem"
    >${escapeHtml(t("card.clear.addProblem"))}</a
  >`;
  const note = escapeHtml(t("today.allDone.note")).replace(
    "{link}",
    addProblem,
  );
  return html`
    <section
      class="home-results__complete"
      aria-labelledby="home-all-done-title"
    >
      <div class="home-results__complete-content">
        <img src="/clear-check-icon.png" alt="" width="96" height="98" />
        <h2 id="home-all-done-title">
          ${escapeHtml(t("today.allDone.title"))}
        </h2>
        <p>${escapeHtml(t("today.allDone.text"))}</p>
        <p class="home-results__complete-note">${note}</p>
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
 * Each reason carries the stored English `value` (submitted to the API, which
 * validates it) and a display `label` in the active language.
 * @param {{ reasons: Array<{ value: string, label: string }> }} vm
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
            data-reason="${escapeAttr(r.value)}"
          >
            ${escapeHtml(r.label)}
          </button>`,
      )
      .join("")}
    <button
      type="button"
      class="home-cta__link actioncard__cancel"
      data-action="cant-cancel"
    >
      ${escapeHtml(t("common.cancel"))}
    </button>
  `;
}

/* ---- Error view ---- */

/**
 * Backend unreachable on load: identity, a plain status, and a retry.
 * @param {{ identity: { org: string, site: string } }} vm
 */
export function errorView({ identity }) {
  return html`
    <div class="home">
      <div
        class="screen"
        role="group"
        aria-label="${escapeAttr(t("today.hero.aria"))}"
      >
        <div class="screen__sec home-lead">
          <div class="home-identity">
            ${identity.org
              ? html`<p class="home-identity__org">
                  ${escapeHtml(identity.org)}
                </p>`
              : ""}
            <h1 class="home-identity__site" tabindex="-1">
              ${escapeHtml(identity.site)}
            </h1>
          </div>
          <div class="lastlog">
            <p class="lastlog__eyebrow">
              ${escapeHtml(t("today.error.title"))}
            </p>
            <p class="lastlog__summary">${escapeHtml(t("today.error.text"))}</p>
          </div>
          <div class="home-actions">
            <button id="retry" class="btn-ink" type="button">
              ${escapeHtml(t("common.retry"))}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}
