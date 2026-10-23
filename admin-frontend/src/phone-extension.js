/** Wrap a phone input with an optional extension disclosure.
 * @param {string} phoneHtml @param {string} extensionHtml @param {string} label
 * @param {boolean} expanded @param {string} removeLabel
 */
export function phoneExtensionField(
  phoneHtml,
  extensionHtml,
  label,
  expanded,
  removeLabel,
) {
  return `<div class="phone-field">${phoneHtml}<button type="button" class="btn-outline phone-field__add" data-add-extension aria-expanded="${expanded}" ${expanded ? "hidden" : ""}>${label}</button><div data-phone-extension ${expanded ? "" : "hidden"}>${extensionHtml}<button type="button" class="btn-outline phone-field__add" data-remove-extension>${removeLabel}</button></div></div>`;
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
  root.querySelectorAll("[data-remove-extension]").forEach((button) => {
    button.addEventListener("click", () => {
      const field = button.closest("[data-phone-extension]");
      const add = field?.parentElement?.querySelector("[data-add-extension]");
      const input = field?.querySelector("wa-input");
      if (
        !(field instanceof HTMLElement) ||
        !(add instanceof HTMLElement) ||
        !input ||
        input.disabled
      )
        return;
      input.value = "";
      input.dispatchEvent(
        new Event("input", { bubbles: true, composed: true }),
      );
      input.dispatchEvent(
        new Event("change", { bubbles: true, composed: true }),
      );
      field.hidden = true;
      add.hidden = false;
      add.setAttribute("aria-expanded", "false");
      add.focus();
    });
  });
}
