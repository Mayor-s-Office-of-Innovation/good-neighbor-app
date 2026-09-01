/*
  feedback-dialog — the "Send feedback" entry point + sheet on the today view.

  The trigger is an icon-only button rendered at the top-right of the home
  header (today-view places it there). A native <dialog> (showModal() gives
  focus trap + Escape for free, same as the dispute sheet in check-results.js)
  with ONE textarea and a submit button.
  Settled scope (docs/todo/feedback-plan.md): textarea-only — no category picker,
  no rating, no email field; feedback is anonymous.

  States: form → sending (disabled + spinner) → thanks (auto-close after a beat).
  Send happens while the dialog is open; failure re-enables the form + shows a
  gentle inline retry (the draft text is never cleared on failure).
*/
import { html } from "../lib/html.js";
import { sendFeedback } from "../services/feedback.js";

const THANKS_MS = 2200;

/**
 * Whether a textarea value is sendable (trimmed non-empty). Exported pure so
 * the node test can exercise the send guard without a DOM.
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function hasSendableText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether closing the dialog should clear the draft: only when the thanks
 * pane is showing (a successful send). Escape/backdrop mid-edit must never
 * discard typing. Exported pure for the node test.
 * @param {boolean} thanksShowing
 * @returns {boolean}
 */
export function clearsDraft(thanksShowing) {
  return thanksShowing === true;
}

class FeedbackDialog extends HTMLElement {
  connectedCallback() {
    this._renderForm();
    this._dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#feedback-dialog")
    );

    this.querySelector("#feedback-open")?.addEventListener("click", () => {
      this._setState("form");
      this._dialog?.showModal();
      /** @type {HTMLElement | null} */ (
        this.querySelector("#feedback-text")
      )?.focus();
    });

    this.querySelector("#feedback-cancel")?.addEventListener("click", () =>
      this._dialog?.close(),
    );
    this.querySelector("#feedback-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this._submit();
    });
    this.querySelector("#feedback-done")?.addEventListener("click", () =>
      this._dialog?.close(),
    );
    // Click on the backdrop (target is the <dialog> itself) dismisses it.
    this._dialog?.addEventListener("click", (e) => {
      if (e.target === this._dialog) this._dialog.close();
    });
  }

  disconnectedCallback() {
    if (this._thanksTimer) clearTimeout(this._thanksTimer);
  }

  async _submit() {
    const textarea = /** @type {HTMLTextAreaElement | null} */ (
      this.querySelector("#feedback-text")
    );
    const text = textarea?.value ?? "";
    if (!hasSendableText(text)) return;

    const send = /** @type {HTMLElement | null} */ (
      this.querySelector("#feedback-send")
    );
    const errEl = /** @type {HTMLElement | null} */ (
      this.querySelector("#feedback-error")
    );
    if (send) {
      /** @type {any} */ (send).disabled = true;
      /** @type {any} */ (send).loading = true;
    }
    if (errEl) errEl.hidden = true;

    try {
      await sendFeedback({
        message: text,
        site: /** @type {any} */ (this).siteId || undefined,
      });
      this._setState("thanks");
      this._thanksTimer = setTimeout(() => this._dialog?.close(), THANKS_MS);
    } catch {
      // Keep the dialog open + the draft intact; offer a gentle retry.
      if (errEl) errEl.hidden = false;
    } finally {
      if (send) {
        /** @type {any} */ (send).disabled = false;
        /** @type {any} */ (send).loading = false;
      }
    }
  }

  /**
   * Swap which pane is visible. (Panes live in one render; toggling `hidden`
   * keeps listeners wired and avoids re-render focus loss.)
   * @param {"form" | "thanks"} state
   */
  _setState(state) {
    const form = /** @type {HTMLElement | null} */ (
      this.querySelector(".feedback__pane--form")
    );
    const thanks = /** @type {HTMLElement | null} */ (
      this.querySelector(".feedback__pane--thanks")
    );
    if (form) form.hidden = state !== "form";
    if (thanks) thanks.hidden = state !== "thanks";
  }

  /** Reset the draft after a successful send (called when the sheet closes). */
  _resetForm() {
    const textarea = /** @type {HTMLTextAreaElement | null} */ (
      this.querySelector("#feedback-text")
    );
    if (textarea) textarea.value = "";
  }

  _renderForm() {
    this.innerHTML = html`
      <button
        class="feedback__open"
        id="feedback-open"
        type="button"
        aria-label="Send feedback about this app"
        title="Send feedback"
      >
        <wa-icon name="comment" aria-hidden="true"></wa-icon>
      </button>

      <dialog
        class="sheet"
        id="feedback-dialog"
        aria-label="Send feedback about this app"
      >
        <div class="sheet__panel feedback__panel">
          <div class="feedback__pane feedback__pane--form">
            <h2 class="visually-hidden">Send feedback about this app</h2>
            <p class="feedback__intro">
              What's working? What's not? Your note goes straight to the team
              building this app.
            </p>
            <form id="feedback-form">
              <textarea
                id="feedback-text"
                class="feedback__textarea"
                name="message"
                rows="4"
                maxlength="2000"
                required
                placeholder="Share an idea, a bug, or a frustration…"
                aria-label="Your feedback"
              ></textarea>
              <p
                class="feedback__error"
                id="feedback-error"
                role="alert"
                hidden
              >
                Couldn't send just now. Your note is still here — try again.
              </p>
              <div class="feedback__actions">
                <button class="btn-outline" id="feedback-cancel" type="button">
                  Cancel
                </button>
                <button class="btn-ink" id="feedback-send" type="submit">
                  Send
                </button>
              </div>
            </form>
          </div>
          <div class="feedback__pane feedback__pane--thanks" hidden>
            <p class="feedback__thanks" aria-live="polite">
              Thanks — your feedback reached the team.
            </p>
            <div class="feedback__actions">
              <button class="btn-ink" id="feedback-done" type="button">
                Done
              </button>
            </div>
          </div>
        </div>
      </dialog>
    `;

    // Clear the draft only after a dialog that ended in a sent state — closing
    // via Escape/backdrop mid-edit must not discard typing. `cancel` fires on
    // Escape; the backdrop-click branch above covers pointing-device dismissal.
    this._dialog?.addEventListener("close", () => {
      const thanksPane = /** @type {HTMLElement | null} */ (
        this.querySelector(".feedback__pane--thanks")
      );
      const thanksShowing = Boolean(thanksPane && !thanksPane.hidden);
      if (clearsDraft(thanksShowing)) this._resetForm();
    });
  }
}

customElements.define("feedback-dialog", FeedbackDialog);
