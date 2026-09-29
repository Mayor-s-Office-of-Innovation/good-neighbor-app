/*
  dialog-controls — the small DOM helpers every analysis dialog shares
  (today-view, perimeter-check, problem-report). Kept DOM-only and stateless.
*/

/**
 * Show or clear an inline error region.
 * @param {ParentNode} root element to search from
 * @param {string} selector selector for the error element
 * @param {string} message empty string hides the region
 */
export function setDialogError(root, selector, message) {
  const error = root.querySelector(selector);
  if (!(error instanceof HTMLElement)) return;
  error.textContent = message;
  error.hidden = !message;
}

/**
 * Disable a button while its request is in flight.
 * @param {Element | null | undefined} button
 * @param {boolean} busy
 */
export function setBusy(button, busy) {
  if (!(button instanceof HTMLButtonElement)) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
}

/**
 * Build an idempotency key: the caller's parts joined by ":" plus a random suffix.
 * @param {...(string | undefined)} parts
 * @returns {string}
 */
export function requestId(...parts) {
  const suffix =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${parts.join(":")}:${suffix}`;
}
