/** Wrap a phone input with an optional extension disclosure.
 * @param {string} phoneHtml @param {string} extensionHtml @param {string} label
 * @param {boolean} expanded
 */
export function phoneExtensionField(phoneHtml, extensionHtml, label, expanded) {
  return `<div class="phone-field">${phoneHtml}<button type="button" class="btn-outline phone-field__add" data-add-extension aria-expanded="${expanded}" ${expanded ? "hidden" : ""}>${label}</button><div data-phone-extension ${expanded ? "" : "hidden"}>${extensionHtml}</div></div>`;
}

/** @param {ParentNode} root */
export function bindPhoneExtensions(root) {
  root.querySelectorAll("[data-add-extension]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.parentElement?.querySelector(
        "[data-phone-extension]",
      );
      if (!(field instanceof HTMLElement)) return;
      field.hidden = false;
      button.setAttribute("aria-expanded", "true");
      /** @type {HTMLElement} */ (button).hidden = true;
      /** @type {HTMLElement | null} */ (
        field.querySelector("wa-input")
      )?.focus();
    });
  });
}
