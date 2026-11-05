/*
  settings-pages — the small settings destinations (Language, About &
  attributions) as pushed screens instead of pop-up dialogs, per the
  settings-menu redesign: they slide in from the right over the open menu
  and their Back arrow returns to it. Header metrics mirror the Reports
  screen (top action row, centered title).
*/
import "./settings-pages.css";
import { announceScreenHeading } from "../screen-focus.js";
import { backOrNavigate, forceNextRouteTransition } from "../router.js";
import { getLocale, setLocale, t, LOCALES } from "../i18n/i18n.js";
import {
  showFeedbackErrorToast,
  showFeedbackSuccessToast,
  showLanguageErrorToast,
} from "../state/toasts.js";
import { getSite } from "../db.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";

/** @param {string} title @param {string} body */
function pageShell(title, body) {
  return html`<div class="settings-page">
    <div class="settings-page__top">
      <button
        type="button"
        class="btn-circle-close"
        data-menu-back
        aria-label="${escapeAttr(t("common.back"))}"
      >
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </button>
    </div>
    <h1 class="settings-page__title" tabindex="-1">${escapeHtml(title)}</h1>
    ${body}
  </div>`;
}

/** @param {HTMLElement} root */
function bindMenuBack(root) {
  root.querySelector("[data-menu-back]")?.addEventListener("click", () => {
    forceNextRouteTransition("pop");
    try {
      sessionStorage.setItem("gnp-reopen-settings", "1");
    } catch {
      /* storage unavailable: land on a plain home screen */
    }
    backOrNavigate("/today");
  });
}

class LanguageView extends HTMLElement {
  connectedCallback() {
    const current = getLocale();
    this.innerHTML = pageShell(
      t("today.language.title"),
      html`<p class="settings-page__copy">
          ${escapeHtml(t("today.language.text"))}
        </p>
        <ul class="settings-page__list" data-testid="language-options">
          ${LOCALES.map(
            (locale) =>
              html`<li>
                <button
                  class="settings-page__option"
                  type="button"
                  lang="${escapeAttr(locale.tag)}"
                  data-locale="${escapeAttr(locale.id)}"
                  ${locale.id === current ? 'aria-current="true"' : ""}
                >
                  <span>${escapeHtml(locale.label)}</span>
                  ${locale.id === current
                    ? '<wa-icon name="check" aria-hidden="true"></wa-icon>'
                    : ""}
                </button>
              </li>`,
          ).join("")}
        </ul>`,
    );
    bindMenuBack(this);
    this.querySelectorAll("[data-locale]").forEach((button) =>
      button.addEventListener("click", () => {
        const chosen = button.getAttribute("data-locale") || "";
        if (!chosen || chosen === getLocale()) return;
        // app-root re-renders this view on "localechange"; a failed catalog
        // load (offline first use of a language) changes nothing — say so.
        void setLocale(chosen).then((ok) => {
          if (!ok) showLanguageErrorToast();
        });
      }),
    );
    announceScreenHeading(this, ".settings-page__title");
  }
}
customElements.define("language-view", LanguageView);

class AttributionsView extends HTMLElement {
  connectedCallback() {
    const links = [
      [
        "https://docs.aws.amazon.com/location/latest/developerguide/data-attribution.html",
        t("today.attributions.aws"),
      ],
      [
        "https://geocoding.geo.census.gov/geocoder/",
        t("today.attributions.census"),
      ],
    ];
    this.innerHTML = pageShell(
      t("today.attributions.title"),
      html`<p class="settings-page__copy">
          ${escapeHtml(t("today.attributions.text"))}
        </p>
        <ul class="settings-page__list">
          ${links
            .map(
              ([href, label]) =>
                html`<li>
                  <a
                    class="settings-page__option"
                    href="${escapeAttr(href)}"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="${escapeAttr(
                      t("common.opensNewTab", { label }),
                    )}"
                  >
                    <span>${escapeHtml(label)}</span>
                  </a>
                </li>`,
            )
            .join("")}
        </ul>`,
    );
    bindMenuBack(this);
    announceScreenHeading(this, ".settings-page__title");
  }
}
customElements.define("attributions-view", AttributionsView);

class FeedbackView extends HTMLElement {
  _siteId = "";
  connectedCallback() {
    this.innerHTML = pageShell(
      t("feedback.dialog.title"),
      html`<p class="settings-page__copy">${escapeHtml(t("feedback.intro"))}</p>
        <form class="settings-page__form" id="feedback-form">
          <wa-textarea
            id="feedback-text"
            name="message"
            rows="5"
            maxlength="2000"
            required
            placeholder="${escapeAttr(t("feedback.textarea.placeholder"))}"
            label="${escapeAttr(t("feedback.textarea.label"))}"
            resize="vertical"
          ></wa-textarea>
          <button
            class="btn-ink settings-page__send"
            id="feedback-send"
            type="submit"
          >
            ${escapeHtml(t("feedback.send"))}
          </button>
        </form>`,
    );
    bindMenuBack(this);
    void getSite()
      .then((site) => {
        this._siteId = site?.siteId || "";
      })
      .catch(() => {});
    this.querySelector("#feedback-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this._submit();
    });
    announceScreenHeading(this, ".settings-page__title");
  }

  async _submit() {
    const textarea = /** @type {any} */ (this.querySelector("#feedback-text"));
    const text = textarea?.value ?? "";
    if (typeof text !== "string" || !text.trim()) return;
    const send = /** @type {any} */ (this.querySelector("#feedback-send"));
    if (send) send.disabled = true;
    try {
      // Submission code is only needed after Send; import failures use the
      // same draft-preserving retry path as network failures.
      const { sendFeedback } = await import("../services/feedback.js");
      await sendFeedback({ message: text, site: this._siteId || undefined });
      showFeedbackSuccessToast();
      // Sent: return to the reopened settings menu, like Back.
      /** @type {HTMLButtonElement | null} */ (
        this.querySelector("[data-menu-back]")
      )?.click();
    } catch {
      // Keep the screen + the draft intact for retry.
      showFeedbackErrorToast();
    } finally {
      if (send) send.disabled = false;
    }
  }
}
customElements.define("feedback-view", FeedbackView);
