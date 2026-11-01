import { html, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

/** @param {any} item @param {string} alt */
export function capturePhoto(item, alt) {
  return html`<capture-photo
    data-media-key="${escapeAttr(item.media.key)}"
    data-check-id="${escapeAttr(item.checkId)}"
    data-artifact-id="${escapeAttr(
      item.analysis?.artifactId ||
        (item.upload?.status === "uploaded" ? item.upload.artifactId : "") ||
        "",
    )}"
  >
    <img hidden alt="${escapeAttr(alt)}" decoding="async" />
    <span
      data-photo-placeholder
      role="img"
      aria-label="${escapeAttr(t("card.pending.title"))}"
      ><wa-icon name="image" aria-hidden="true"></wa-icon
    ></span>
  </capture-photo>`;
}
