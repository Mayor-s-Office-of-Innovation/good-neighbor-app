/*
  connection-state.js — the UI surface for backend-health.js states
  (api-response-integrity plan §3b).

  OUTAGE → an informational app toast, shown once per outage period.

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
import { showOfflinePhotosToast } from "../state/toasts.js";

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
            Sign out and re-enter your site's code to keep this device working.
            Signing out removes this site's saved photos and drafts from the
            device.
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
  /** @type {string | undefined} */
  _lastState;

  _sync() {
    const state = getHealthState();
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#conn-auth-dialog")
    );

    if (state === "outage" && this._lastState !== "outage") {
      showOfflinePhotosToast();
    }
    this._lastState = state;

    if (state === "auth") {
      if (dialog && !dialog.open) dialog.showModal();
      return;
    }

    dialog?.close();
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
