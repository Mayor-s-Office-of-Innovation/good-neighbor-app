import { loadError } from "./load-error.js";
import { t } from "../i18n/i18n.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
/** @param {string} title */
export function adminHeader(title) {
  return html`<header class="site-admin-header">
    <button
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

/** @param {string} title */
export function loadingView(title) {
  return html`<div class="site-admin-page">
    ${adminHeader(title)}
    <div class="site-admin-loading">
      <wa-spinner></wa-spinner> ${escapeHtml(t("common.loading"))}
    </div>
  </div>`;
}

/** @param {string} message */
export function errorView(message) {
  return html`<div class="site-admin-page">
    ${adminHeader(t("siteAdmin.title"))} ${loadError(message)}
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
