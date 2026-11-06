import { t } from "../i18n/i18n.js";
import { escapeHtml, escapeAttr, html } from "../lib/html.js";
import { openOverlayDialog } from "../dialog-history.js";

/** @param {HTMLElement} view @param {{code?:string,grantId?:string}} grant @param {HTMLButtonElement} trigger */
export function showEnrollmentCode(view, grant, trigger) {
  if (
    !grant.code ||
    trigger.disabled ||
    view.querySelector(".site-access-code-dialog")
  )
    return;
  const dialog = document.createElement("dialog");
  dialog.className = "places-modal site-access-code-dialog";
  dialog.setAttribute("data-code-grant-id", grant.grantId || "");
  dialog.setAttribute("aria-labelledby", "enrollment-code-title");
  dialog.setAttribute("aria-describedby", "enrollment-code-guidance");
  dialog.innerHTML = html`<div class="places-modal__card">
    <header class="site-access-code-header">
      <h2 class="places-modal__title" id="enrollment-code-title">
        ${escapeHtml(t("access.showCode"))}
      </h2>
      <button
        class="btn-icon"
        type="button"
        data-close-code
        aria-label="${escapeAttr(t("common.close"))}"
      >
        <wa-icon name="xmark" aria-hidden="true"></wa-icon>
      </button>
    </header>
    <p class="places-modal__text" id="enrollment-code-guidance">
      ${escapeHtml(t("access.codeGuidance"))}
    </p>
    <div data-code-output aria-live="polite"></div>
    <button class="btn-ink" type="button" data-display-code>
      ${escapeHtml(t("access.displayCode"))}
    </button>
    <button class="btn-outline" type="button" data-cancel-code>
      ${escapeHtml(t("common.cancel"))}
    </button>
  </div>`;
  let displayed = false;
  dialog
    .querySelector("[data-display-code]")
    ?.addEventListener("click", (event) => {
      if (!grant.code) return;
      displayed = true;
      const output = dialog.querySelector("[data-code-output]");
      output.textContent = grant.code;
      output.className = "site-access-code-value";
      delete grant.code;
      /** @type {HTMLElement} */ (event.currentTarget).remove();
      const closeButton = /** @type {HTMLButtonElement} */ (
        dialog.querySelector("[data-cancel-code]")
      );
      closeButton.textContent = t("common.close");
      closeButton.focus();
    });
  for (const button of dialog.querySelectorAll(
    "[data-close-code], [data-cancel-code]",
  ))
    button.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener(
    "close",
    () => {
      if (displayed) trigger.disabled = true;
      dialog.replaceChildren();
      dialog.remove();
      if (trigger.isConnected) {
        const target = trigger.disabled
          ? trigger
              .closest("[data-grant-id]")
              ?.querySelector("[data-share-grant]")
          : trigger;
        if (target instanceof HTMLElement) target.focus();
      }
    },
    { once: true },
  );
  view.append(dialog);
  openOverlayDialog(dialog, "enrollment-code");
}
