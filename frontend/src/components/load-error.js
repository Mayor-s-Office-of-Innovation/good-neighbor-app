import { escapeHtml, escapeAttr, html } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
/** A failed read does not erase available data or navigation.
 * @param {string} message
 * @param {{partial?: boolean, retryAttribute?: string, retryId?: string}} [options]
 */
export function loadError(
  message,
  { partial = false, retryAttribute = "data-load-retry", retryId = "" } = {},
) {
  return html`<section
    class="${partial
      ? "app-error app-error--panel app-error--neutral"
      : "app-load-error"}"
    role="alert"
  >
    ${partial ? "" : '<wa-icon name="rotate" aria-hidden="true"></wa-icon>'}
    <strong>${escapeHtml(message)}</strong>
    <p>${escapeHtml(t(partial ? "notice.statusHelp" : "notice.loadHelp"))}</p>
    <button
      class="btn-outline btn-outline--sm"
      type="button"
      ${retryAttribute}
      ${retryId ? `id="${escapeAttr(retryId)}"` : ""}
    >
      ${escapeHtml(t("notice.retry"))}
    </button>
  </section>`;
}
