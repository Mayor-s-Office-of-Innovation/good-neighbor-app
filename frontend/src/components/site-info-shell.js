import { loadError } from "./load-error.js";
import { t } from "../i18n/i18n.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
/** @param {string} title @param {boolean} [close] */
export function adminHeader(title, close = false) {
  /* Top-level screens ("close" mode) follow the settings-menu spec: a
     single Back (to the reopened menu) on a Reports-style action row, then
     the centered title. Sub-screens keep the inline back-to-parent row. */
  if (close) {
    return html`<header class="site-admin-header site-admin-header--close">
      <div class="site-admin-header__top">
        <button
          class="btn-circle-close"
          data-menu-back
          type="button"
          aria-label="${escapeAttr(t("common.back"))}"
        >
          <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
        </button>
      </div>
      <h1 tabindex="-1">${escapeHtml(title)}</h1>
    </header>`;
  }
  return html`<header class="site-admin-header">
    <button
      class="btn-icon"
      data-admin-back
      type="button"
      aria-label="${escapeAttr(t("common.back"))}"
    >
      <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
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
