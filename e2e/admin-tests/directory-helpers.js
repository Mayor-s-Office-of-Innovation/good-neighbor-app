// Web Awesome selects keep their value on the host element, so tests set it
// there and fire the input and change events the admin forms listen for.

/**
 * Set a Web Awesome or native control's value and fire input + change.
 * @param {import("@playwright/test").Locator} control
 * @param {string} value
 */
export async function setControl(control, value) {
  await control.evaluate(async (element, next) => {
    /** @type {any} */ (element).value = next;
    // Form value syncs on the next Lit update; FormData reads it on change.
    await /** @type {any} */ (element).updateComplete;
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  }, value);
}

/**
 * Fail the first `times` matching reads, then let the defaults answer.
 * @param {number} times
 * @param {number} [status]
 * @param {string} [error]
 */
export function failTimes(times, status = 500, error = "Synthetic failure") {
  let left = times;
  return () => {
    if (left <= 0) return undefined;
    left -= 1;
    // A message unlike the code, so a pin on the raw code flips once it's fixed.
    return { status, json: { error, message: `${error} (message)` } };
  };
}
