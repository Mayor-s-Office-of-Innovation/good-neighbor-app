import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

/**
 * Shared capture actions; callers own the inputs and text-entry flow.
 * @param {{ cameraId?: string, textId?: string, textKey?: string, disabled?: boolean, photosAllowed?: boolean, showText?: boolean }} options
 */
export function captureControls({
  cameraId = "",
  textId = "",
  textKey = "check.describeInstead",
  disabled = false,
  photosAllowed = true,
  showText = true,
} = {}) {
  return html`<div class="capture-controls">
    ${photosAllowed
      ? html`<button
          type="button"
          class="btn-blue capture-controls__camera"
          ${cameraId ? `id="${escapeAttr(cameraId)}"` : ""}
          data-capture-camera
          ${disabled ? "disabled" : ""}
        >
          <wa-icon name="camera" aria-hidden="true"></wa-icon>${escapeHtml(
            t("check.photo.take"),
          )}
        </button>`
      : ""}
    <div class="capture-controls__secondary">
      ${showText
        ? html`<button
            type="button"
            class="btn-outline"
            ${textId ? `id="${escapeAttr(textId)}"` : ""}
            data-capture-text
            ${disabled ? "disabled" : ""}
          >
            <wa-icon name="keyboard" aria-hidden="true"></wa-icon>${escapeHtml(
              t(textKey),
            )}
          </button>`
        : ""}
      ${photosAllowed
        ? html`<button
            type="button"
            class="btn-outline"
            data-capture-upload
            ${disabled ? "disabled" : ""}
          >
            <wa-icon name="image" aria-hidden="true"></wa-icon>${escapeHtml(
              t("check.photo.upload"),
            )}
          </button>`
        : ""}
    </div>
  </div>`;
}
