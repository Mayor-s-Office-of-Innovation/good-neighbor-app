import { loadError } from "./load-error.js";
import { t } from "../i18n/i18n.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
/** @param {string} title @param {boolean} [close] */
export function adminHeader(title, close = false) {
  return html`<header
    class="site-admin-header ${close ? "site-admin-header--close" : ""}"
  >
    <button
      class="${close ? "btn-circle-close" : "btn-icon"}"
      data-admin-back
      type="button"
      aria-label="${escapeAttr(t(close ? "common.close" : "common.back"))}"
    >
      <wa-icon
        name="${close ? "xmark" : "chevron-left"}"
        aria-hidden="true"
      ></wa-icon>
    </button>
    <h1 tabindex="-1">${escapeHtml(title)}</h1>
    <span aria-hidden="true"></span>
  </header>`;
}

/** @param {string} title @param {boolean} [close] */
export function loadingView(title, close = false) {
  return html`<div class="site-admin-page">
    ${adminHeader(title, close)}
    <div class="site-admin-loading">
      <wa-spinner></wa-spinner> ${escapeHtml(t("common.loading"))}
    </div>
  </div>`;
}

/** @param {string} message @param {boolean} [close] */
export function errorView(message, close = false) {
  return html`<div class="site-admin-page">
    ${adminHeader(t("siteAdmin.title"), close)} ${loadError(message)}
  </div>`;
}

export function field(id, label, value, autocomplete, type, required = true) {
  return html`<wa-input
    id="${id}"
    label="${escapeAttr(label)}"
    value="${escapeAttr(value)}"
    autocomplete="${autocomplete}"
    type="${type}"
    size="large"
    ${required ? "required" : ""}
  ></wa-input>`;
}
