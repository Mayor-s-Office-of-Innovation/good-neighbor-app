/** Hold background paints while the user owns the current DOM.
 * @param {HTMLElement} host @param {() => void} flush
 */
export function installHomeInteractionGuard(host, flush) {
  let pressed = false;
  let scrollingUntil = 0;
  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, scrollingUntil - Date.now()) + 20);
  };
  const down = () => {
    pressed = true;
  };
  const up = () => {
    pressed = false;
    schedule();
  };
  const scroll = () => {
    scrollingUntil = Date.now() + 200;
    schedule();
  };
  /** @type {[EventTarget, string, EventListener][]} */
  const events = [
    [host, "pointerdown", down],
    [window, "pointerup", up],
    [window, "pointercancel", up],
    [window, "blur", up],
    [window, "scroll", scroll],
    [host, "wheel", scroll],
    [document, "focusout", schedule],
    [document, "selectionchange", schedule],
    [document, "click", schedule],
    [document, "close", schedule],
  ];
  for (const [target, event, handler] of events)
    target.addEventListener(event, handler, { passive: true, capture: true });
  return {
    busy: () =>
      pressed ||
      Date.now() < scrollingUntil ||
      Boolean(
        document.querySelector("dialog[open]") ||
          host.querySelector('[role="menu"]:not([hidden])') ||
          (host.contains(document.activeElement) &&
            document.activeElement?.matches(
              "input, textarea, select, [contenteditable], wa-input, wa-textarea, wa-select",
            )) ||
          (window.getSelection()?.toString() &&
            host.contains(window.getSelection()?.anchorNode)),
      ),
    dispose: () => {
      clearTimeout(timer);
      for (const [target, event, handler] of events)
        target.removeEventListener(event, handler, true);
    },
  };
}
