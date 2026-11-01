import "./app-toasts.css";
import { getToasts, onToastsChange } from "../state/toasts.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

/** App-level host: route changes replace #view, leaving notifications intact. */
class AppToasts extends HTMLElement {
  /** @type {Map<ReturnType<typeof getToasts>[number], HTMLElement>} */
  _elements = new Map();
  /** @type {(() => void) | undefined} */
  _unsubscribe;
  /** @type {HTMLElement | null} */
  _returnFocus = null;

  connectedCallback() {
    // A manual popover puts the single global toast host in the browser's top
    // layer, so notifications remain visible above an open modal <dialog>.
    this.setAttribute("popover", "manual");
    this.setAttribute("aria-label", t("toastUi.region.aria"));
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

  /** Keep active notifications at the front of the browser's top layer. */
  _syncTopLayer(hasToasts) {
    if (
      typeof this.showPopover !== "function" ||
      typeof this.hidePopover !== "function"
    )
      return;
    try {
      const open = this.matches(":popover-open");
      if (!hasToasts) {
        if (open) this.hidePopover();
        return;
      }
      // Reopening promotes the host above a modal that may have opened while
      // an earlier toast was still active.
      if (open) this.hidePopover();
      this.showPopover();
    } catch {
      // Older browsers keep the existing fixed-position fallback.
    }
  }

  _sync() {
    const current = getToasts();
    /** @type {HTMLElement | null} */
    let focusTarget = null;
    for (const [toast, element] of this._elements) {
      if (current.includes(toast)) continue;
      const hadFocus = element.contains(document.activeElement);
      element.remove();
      this._elements.delete(toast);
      if (hadFocus) {
        const dialog = document.querySelector("dialog[open]");
        const previous = this._returnFocus;
        const validPrevious =
          previous?.isConnected &&
          !previous.closest("[inert]") &&
          !previous.matches(":disabled") &&
          (!dialog || dialog.contains(previous));
        const target = validPrevious
          ? previous
          : dialog || document.querySelector("#view, #main-content");
        if (target instanceof HTMLElement) {
          if (!validPrevious && !target.hasAttribute("tabindex"))
            target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        }
      }
    }
    for (const toast of current) {
      if (this._elements.has(toast)) continue;
      const element = document.createElement("section");
      element.className = `app-toast app-toast--${toast.tone || "neutral"}`;
      if (toast.fullWidth) element.classList.add("app-toast--full-width");
      element.innerHTML = html` <wa-icon
          class="app-toast__icon"
          name="${escapeAttr(
            toast.icon ||
              (toast.tone === "warning"
                ? "triangle-exclamation"
                : "circle-check"),
          )}"
          aria-hidden="true"
        ></wa-icon>
        <div class="app-toast__copy">
          <div role="status" aria-atomic="true"></div>
          ${toast.action
            ? html`<button type="button" class="app-toast__undo">
                ${escapeHtml(toast.action.label)}
              </button>`
            : ""}
        </div>
        <div class="app-toast__controls">
          <button
            type="button"
            class="app-toast__close"
            aria-label="${escapeAttr(
              t("toastUi.dismiss.aria", { title: toast.title }),
            )}"
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
          ${toast.message || toast.link
            ? html`<p class="app-toast__message">
                ${escapeHtml(toast.message)}${toast.link
                  ? html`<a href="${escapeAttr(toast.link.href)}"
                      >${escapeHtml(toast.link.label)}</a
                    >`
                  : ""}
              </p>`
            : ""}
          ${toast.action
            ? html`<span class="visually-hidden"
                >${escapeHtml(t("toastUi.undoHint"))}</span
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
      element.addEventListener("focusin", (event) => {
        const previous = event.relatedTarget;
        if (
          previous instanceof HTMLElement &&
          !this.contains(previous) &&
          previous !== document.body
        )
          this._returnFocus = previous;
        toast.pause("focus");
      });
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
        if (undo instanceof HTMLElement) focusTarget = undo;
      }
    }
    this._syncTopLayer(current.length > 0);
    focusTarget?.focus({ preventScroll: true });
    this._visibility();
  }
}

customElements.define("app-toasts", AppToasts);
