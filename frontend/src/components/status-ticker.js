import { statusTicker } from "../domain/status-ticker.js";
import { t } from "../i18n/i18n.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import "./status-ticker.css";

/** @param {Record<string, any>} task @param {{history?:boolean, now?:number}} [options] */
export function statusTickerMarkup(task, options) {
  const ticker = statusTicker(task, options);
  if (!ticker.key) return "";
  return html`<span
    class="status-ticker status-ticker--${escapeAttr(ticker.tone)}"
    data-status-ticker="${escapeAttr(ticker.key)}"
  >
    ${ticker.icon === "dot"
      ? '<span class="status-ticker__dot" aria-hidden="true"></span>'
      : html`<wa-icon
          name="${escapeAttr(ticker.icon)}"
          class="${ticker.icon === "spinner" ? "status-ticker__spinner" : ""}"
          aria-hidden="true"
        ></wa-icon>`}
    <span
      >${escapeHtml(
        t(`card.ticker.${ticker.key}`, { count: ticker.count }),
      )}</span
    >
  </span>`;
}
