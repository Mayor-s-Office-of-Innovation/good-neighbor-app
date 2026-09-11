import { getToasts, onToastsChange } from "../state/toasts.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

/** App-level host: route changes replace #view, leaving notifications intact. */
class AppToasts extends HTMLElement {
  /** @type {Map<ReturnType<typeof getToasts>[number], HTMLElement>} */
  _elements = new Map();
  /** @type {(() => void) | undefined} */
  _unsubscribe;

  connectedCallback() {
    this.setAttribute("aria-label", "Notifications");
    this.setAttribute("role", "region");
    this._unsubscribe = onToastsChange(() => this._sync());
    document.addEventListener("visibilitychange", this._visibility);
    this._sync();
  }

  disconnectedCallback() {
    this._unsubscribe?.();
    document.removeEventListener("visibilitychange", this._visibility);
  }

  _visibility = () => {
    for (const toast of getToasts()) {
      if (document.hidden) toast.pause("hidden");
      else toast.resume("hidden");
    }
  };

  _sync() {
    const current = getToasts();
    for (const [toast, element] of this._elements) {
      if (current.includes(toast)) continue;
      const hadFocus = element.contains(document.activeElement);
      element.remove();
      this._elements.delete(toast);
      if (hadFocus) {
        const target = document.querySelector("#view");
        if (target instanceof HTMLElement)
          target.focus({ preventScroll: true });
      }
    }
    for (const toast of current) {
      if (this._elements.has(toast)) continue;
      const element = document.createElement("section");
      element.className = `app-toast app-toast--${toast.tone || "neutral"}`;
      element.innerHTML = html` <wa-icon
          class="app-toast__icon"
          name="${escapeAttr(toast.icon || "circle-check")}"
          aria-hidden="true"
        ></wa-icon>
        <div class="app-toast__copy">
          <div role="status" aria-atomic="true"></div>
        </div>
        <div class="app-toast__controls">
          ${toast.action
            ? html`<button type="button" class="app-toast__undo">
                ${escapeHtml(toast.action.label)}
              </button>`
            : ""}
          <button
            type="button"
            class="app-toast__close"
            aria-label="Dismiss ${escapeAttr(toast.title)} notification"
          >
            <wa-icon name="xmark" aria-hidden="true"></wa-icon>
          </button>
        </div>`;
      this.append(element);
      // Populate an already-mounted live region; keep controls outside it.
      const status = element.querySelector('[role="status"]');
      if (status)
        status.innerHTML = html`<p class="app-toast__title">
            ${escapeHtml(toast.title)}
          </p>
          <p class="app-toast__message">
            ${escapeHtml(toast.message)}${toast.link
              ? html`<a href="${escapeAttr(toast.link.href)}"
                  >${escapeHtml(toast.link.label)}</a
                >`
              : ""}
          </p>
          ${toast.action
            ? html`<span class="visually-hidden"
                >Undo is available in Notifications.</span
              >`
            : ""}`;
      element
        .querySelector(".app-toast__undo")
        ?.addEventListener("click", () => toast.close(true));
      element
        .querySelector(".app-toast__close")
        ?.addEventListener("click", () => toast.close());
      element.querySelector("a")?.addEventListener("click", (event) => {
        const click = /** @type {MouseEvent} */ (event);
        if (
          click.button === 0 &&
          !click.ctrlKey &&
          !click.metaKey &&
          !click.shiftKey &&
          !click.altKey
        ) {
          // Leave the anchor mounted until the router's delegated click runs.
          queueMicrotask(() => toast.close());
        }
      });
      element.addEventListener("pointerenter", () => toast.pause("pointer"));
      element.addEventListener("pointerleave", () => toast.resume("pointer"));
      element.addEventListener("focusin", () => toast.pause("focus"));
      element.addEventListener("focusout", (event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !element.contains(event.relatedTarget)
        )
          toast.resume("focus");
      });
      this._elements.set(toast, element);
      if (toast.focusAction) {
        const undo = element.querySelector(".app-toast__undo");
        if (undo instanceof HTMLElement) undo.focus({ preventScroll: true });
      }
    }
    this._visibility();
  }
}

customElements.define("app-toasts", AppToasts);
