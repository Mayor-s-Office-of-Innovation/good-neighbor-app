/*
  connection-status.js — the UI surface for backend-health.js states
  (api-response-integrity plan §3b).

  OUTAGE → the shared reachability banner; authentication remains separate.

  AUTH → expired/revoked session dialog. ACCESS → missing manager enrollment.
  Both may be cancelled without clearing local work. Explicit sign-out clears
  the site binding and drafts before app-root returns to setup.

  Rendered by app-root alongside app-toasts.
*/

import {
  clearAccessState,
  getHealthState,
  onHealthChange,
} from "../services/backend-health.js";
import { clearSiteSession } from "../db.js";
import { retireHandoff } from "../services/session-handoff.js";
import { discardInMemorySession } from "../state/check-session.js";
import { html, escapeHtml } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

class ConnectionStatus extends HTMLElement {
  connectedCallback() {
    this._unsubscribe = onHealthChange(() => this._sync());
    this.innerHTML = html`<dialog
      class="places-modal conn-modal"
      id="conn-auth-dialog"
      aria-labelledby="conn-auth-title"
      aria-describedby="conn-auth-message"
    >
      <form class="places-modal__card" method="dialog">
        <div class="places-modal__copy">
          <h2 class="places-modal__title" id="conn-auth-title">
            ${escapeHtml(t("connection.authExpired.title"))}
          </h2>
          <p class="places-modal__text" id="conn-auth-message">
            ${escapeHtml(t("connection.authExpired.message"))}
          </p>
        </div>
        <div class="places-modal__actions">
          <button
            class="btn-outline"
            id="conn-auth-cancel"
            type="button"
            autofocus
          >
            ${escapeHtml(t("common.cancel"))}
          </button>
          <button
            class="btn-ink places-modal__primary"
            id="conn-auth-signout"
            type="button"
          >
            ${escapeHtml(t("connection.authExpired.signOut"))}
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
        // The session is already dead here, so only the local half of the
        // handoff retire applies: stop offering the grant from this page.
        await retireHandoff({ remote: false });
        await clearSiteSession();
        window.dispatchEvent(new CustomEvent("authsignout"));
      },
    );
    this.querySelector("#conn-auth-cancel")?.addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#conn-auth-dialog")?.addEventListener(
      "cancel",
      (event) => {
        event.preventDefault();
        this._cancel();
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

  /** @type {string | undefined} */
  _dismissedState;

  _cancel() {
    this._dismissedState = getHealthState();
    /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#conn-auth-dialog")
    )?.close();
    clearAccessState();
  }

  _sync() {
    const state = getHealthState();
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#conn-auth-dialog")
    );

    if (state !== this._lastState) this._dismissedState = undefined;
    this._lastState = state;

    if (state === "auth" || state === "access") {
      const prefix =
        state === "access"
          ? "connection.accessDenied"
          : "connection.authExpired";
      for (const [selector, key] of [
        ["#conn-auth-title", "title"],
        ["#conn-auth-message", "message"],
        ["#conn-auth-signout", "signOut"],
      ]) {
        const element = this.querySelector(selector);
        if (element) element.textContent = t(`${prefix}.${key}`);
      }
      if (dialog && !dialog.open && this._dismissedState !== state)
        dialog.showModal();
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
