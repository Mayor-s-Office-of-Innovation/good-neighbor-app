// Small DOM/formatting helpers shared by the admin pages.

/**
 * @param {EventTarget | null} target
 * @returns {HTMLFormElement}
 */
export function asForm(target) {
  if (target instanceof HTMLFormElement) return target;
  throw new TypeError("Expected form event target");
}

/**
 * @param {Element} element
 * @param {string} name
 * @returns {string}
 */
export function dataAttr(element, name) {
  return element.getAttribute(name) ?? "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function formatTimestamp(value) {
  if (!value) return "not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not available";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
