// wa-input builders for the admin forms. syncProviderDetailsForm and
// syncSiteDetailsForm read data-initial-value to keep Save off until a field changes.
import { phoneExtensionField } from "./phone-extension.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "./dom.js";

/** @param {string} name @param {string} label @param {unknown} value
 * @param {Parameters<typeof formInput>[3] & { extension?: string, extensionName?: string }} [options]
 */
export function phoneInput(name, label, value, options = {}) {
  const extensionName =
    options.extensionName ||
    (name === "phone"
      ? "phoneExtension"
      : name.replace(/-phone$/, "-extension"));
  return phoneExtensionField(
    formInput(name, label, value, options),
    formInput(
      extensionName,
      t("admin.phone.extension"),
      options.extension || "",
      {
        autocomplete: "tel-extension",
        maxlength: 20,
        disabled: options.disabled,
      },
    ),
    escapeHtml(t("admin.phone.addExtension")),
    Boolean(options.extension),
    escapeHtml(t("admin.phone.removeExtension")),
  );
}

/**
 * @param {string} name
 * @param {string} label
 * @param {unknown} value
 * @param {{ required?: boolean, disabled?: boolean, type?: string, autocomplete?: string, pattern?: string, maxlength?: number, min?: number, max?: number, step?: number }} [options]
 */
export function formInput(name, label, value, options = {}) {
  const attributes = [
    options.required ? "required" : "",
    options.disabled ? "disabled" : "",
    options.autocomplete
      ? `autocomplete="${escapeHtml(options.autocomplete)}"`
      : "",
    options.pattern ? `pattern="${escapeHtml(options.pattern)}"` : "",
    options.maxlength !== undefined ? `maxlength="${options.maxlength}"` : "",
    options.min !== undefined ? `min="${options.min}"` : "",
    options.max !== undefined ? `max="${options.max}"` : "",
    options.step !== undefined ? `step="${options.step}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<wa-input label="${escapeHtml(label)}" name="${escapeHtml(name)}" type="${escapeHtml(options.type || "text")}" value="${escapeHtml(value ?? "")}" data-initial-value="${escapeHtml(value ?? "")}" ${attributes}></wa-input>`;
}
