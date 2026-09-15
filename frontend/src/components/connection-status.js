/*
  connection-state.js — the UI surface for backend-health.js states
  (api-response-integrity plan §3b).

  OUTAGE → a compact dismissible banner ("can't reach the server"), appended
  as a fixed element so it survives route changes without touching #view.
  Clears on the first healthy probe (backend-health → healthy).

  AUTH → a non-dismissable dialog: the device session is expired/revoked and
  the only recovery is site re-entry. "Sign out and re-enter site code"
  clears the site binding AND site-scoped local data (drafts/review are keyed
  per-site-only-in-memory — they must not leak into a different site's
  binding), then app-root re-renders <site-setup> and resets the health
  state so this dialog cannot re-open over the setup form.

  Rendered by app-root alongside app-toasts.
*/

import { getHealthState, onHealthChange } from "../services/backend-health.js";
import { clearSiteSession } from "../db.js";
import { discardInMemorySession } from "../state/check-session.js";
import { html } from "../lib/html.js";

class ConnectionStatus extends HTMLElement {
  connectedCallback() {
    this._unsubscribe = onHealthChange(() => this._sync());
    this.innerHTML = html`<dialog
      class="places-modal conn-modal"
      id="conn-auth-dialog"
      aria-labelledby="conn-auth-title"
    >
      <form class="places-modal__card" method="dialog">
        <div class="places-modal__copy">
          <h2 class="places-modal__title" id="conn-auth-title">
            This device's sign-in has expired or been revoked.
          </h2>
          <p class="places-modal__text">
            Sign out and re-enter your site's code to keep this device
            working. Signing out removes this site's saved photos and drafts
            from the device.
          </p>
        </div>
        <div class="places-modal__actions">
          <button
            class="btn-ink places-modal__primary"
            id="conn-auth-signout"
            type="button"
          >
            Sign out and re-enter site code
          </button>
        </div>
      </form>
    </dialog>`;
    this.querySelector("#conn-auth-signout")?.addEventListener(
      "click",
      async () => {
        // Full site-scoped clear: binding + drafts + review + in-memory walk
        // (drafts/review are keyed by flow type, not site — letting them
        // survive would leak a previous site's photos into a different
        // site's binding after re-entry).
        discardInMemorySession();
        await clearSiteSession();
        window.dispatchEvent(new CustomEvent("authsignout"));
      },
    );
    this._sync();
  }

  disconnectedCallback() {
    this._unsubscribe?.();
  }

  /** @type {(() => void) | undefined} */
  _unsubscribe;
  /** @type {boolean} */
  _dismissed = false;

  _sync() {
    const state = getHealthState();
    const banner = this.querySelector(".conn-banner");
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#conn-auth-dialog")
    );

    if (state === "auth") {
      // Banner never shows in the AUTH state — the dialog owns the screen.
      banner?.remove();
      if (dialog && !dialog.open) dialog.showModal();
      return;
    }

    dialog?.close();
    if (state === "outage" && !banner && !this._dismissed) {
      this.insertAdjacentHTML(
        "beforeend",
        html`<div class="conn-banner" role="status">
          <wa-icon name="cloud-slash" aria-hidden="true"></wa-icon>
          <p>
            <strong>Can't reach the server.</strong> Your photos are still saved
            on this device — we'll retry automatically.
          </p>
          <button
            type="button"
            class="conn-banner__close"
            aria-label="Dismiss connection notice"
          >
            <wa-icon name="xmark" aria-hidden="true"></wa-icon>
          </button>
        </div>`,
      );
      this.querySelector(".conn-banner__close")?.addEventListener(
        "click",
        () => {
          // Dismiss until the next state change (outage → healthy → outage).
          this.querySelector(".conn-banner")?.remove();
          this._dismissed = true;
        },
      );
    } else if (state === "healthy" && banner) {
      banner.remove();
      this._dismissed = false;
    }
  }
}

const isCustomElementsAvailable = () => {
  try {
    return typeof customElements !== "undefined" && !!customElements?.get;
  } catch {
    return false;
  }
};

if (isCustomElementsAvailable() && !customElements.get("connection-status")) {
  customElements.define("connection-status", ConnectionStatus);
}

export default ConnectionStatus;
