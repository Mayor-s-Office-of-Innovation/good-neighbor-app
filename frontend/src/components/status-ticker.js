import { statusTicker } from "../domain/status-ticker.js";
import { t } from "../i18n/i18n.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import "./status-ticker.css";

/**
 * Eight dots in the Font Awesome spinner's positions, fading in sequence
 * around the ring (nothing rotates). Inline SVG because the dots of a wa-icon
 * glyph can't be animated individually; opacity only — at 15px a scale on a
 * 2px dot is sub-pixel, and SVG child transforms don't composite in Chrome.
 * Negative delays start the wave mid-cycle instead of all-on.
 * @returns {string}
 */
function spinnerMarkup() {
  const cycle = 1.1;
  const dots = [
    [8, 2.5],
    [11.89, 4.11],
    [13.5, 8],
    [11.89, 11.89],
    [8, 13.5],
    [4.11, 11.89],
    [2.5, 8],
    [4.11, 4.11],
  ];
  return html`<svg
    class="status-ticker__spinner"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    ${dots
      .map(
        ([cx, cy], index) =>
          html`<circle
            cx="${cx}"
            cy="${cy}"
            r="1.6"
            style="animation-delay: ${(
              (index / dots.length - 1) *
              cycle
            ).toFixed(4)}s"
          ></circle>`,
      )
      .join("")}
  </svg>`;
}

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
      : ticker.icon === "spinner"
        ? spinnerMarkup()
        : html`<wa-icon
            name="${escapeAttr(ticker.icon)}"
            aria-hidden="true"
          ></wa-icon>`}
    <span
      >${escapeHtml(
        t(`card.ticker.${ticker.key}`, { count: ticker.count }),
      )}</span
    >
  </span>`;
}
