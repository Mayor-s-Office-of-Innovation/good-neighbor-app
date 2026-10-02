/*
  feedback-dialog — the "Send feedback" entry point + sheet on the today view.

  The trigger is an icon-only button rendered at the top-right of the home
  header (today-view places it there). A native <dialog> (showModal() gives
  focus trap + Escape for free)
  with ONE textarea and a submit button (textarea is the WA control per the
  design system; buttons stay native — see docs/frontend-design-system.md,
  which reserves .btn-ink/.btn-outline for primary CTAs). Settled scope:
  textarea-only — no category
  picker, no rating, no email field; feedback is anonymous.

  Send happens while the dialog is open. Success closes and clears the form;
  failure re-enables it and preserves the draft. Both outcomes use app toasts.
*/
import "./feedback-dialog.css";
import { html } from "../lib/html.js";
import { openOverlayDialog } from "../dialog-history.js";
import { sendFeedback } from "../services/feedback.js";
import {
  showFeedbackErrorToast,
  showFeedbackSuccessToast,
} from "../state/toasts.js";

/**
 * Whether a textarea value is sendable (trimmed non-empty). Exported pure so
 * the node test can exercise the send guard without a DOM.
 * @param {string | undefined} value
 * @returns {boolean}
 */
export function hasSendableText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

class FeedbackDialog extends HTMLElement {
  /** @type {HTMLDialogElement | null} */
  _dialog = null;
  connectedCallback() {
    this._renderForm();
    this._dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#feedback-dialog")
    );

    this.querySelector("#feedback-open")?.addEventListener("click", () => {
      this.open();
    });

    this.querySelector("#feedback-cancel")?.addEventListener("click", () =>
      this._dialog?.close(),
    );
    this.querySelector("#feedback-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      void this._submit();
    });
    // Click on the backdrop (target is the <dialog> itself) dismisses it.
    this._dialog?.addEventListener("click", (e) => {
      if (e.target === this._dialog) this._dialog.close();
    });
  }

  /** Open the sheet from an external menu item. */
  open() {
    openOverlayDialog(
      /** @type {HTMLDialogElement} */ (this._dialog),
      "feedback",
    );
    /** @type {HTMLElement | null} */ (
      this.querySelector("#feedback-text")
    )?.focus();
  }

  async _submit() {
    const textarea = /** @type {any} */ (this.querySelector("#feedback-text"));
    // wa-textarea exposes its value as a property (and syncs it to the inner
    // native control), so read it like any form control.
    const text = textarea?.value ?? "";
    if (!hasSendableText(text)) return;

    const send = /** @type {HTMLElement | null} */ (
      this.querySelector("#feedback-send")
    );
    if (send) {
      /** @type {any} */ (send).disabled = true;
      /** @type {any} */ (send).loading = true;
    }
    try {
      await sendFeedback({
        message: text,
        site: /** @type {any} */ (this).siteId || undefined,
      });
      showFeedbackSuccessToast();
      this._resetForm();
      this._dialog?.close();
    } catch {
      // Keep the dialog open + the draft intact for retry.
      showFeedbackErrorToast();
    } finally {
      if (send) {
        /** @type {any} */ (send).disabled = false;
        /** @type {any} */ (send).loading = false;
      }
    }
  }

  /** Reset the draft after a successful send (called when the sheet closes). */
  _resetForm() {
    const textarea = /** @type {any} */ (this.querySelector("#feedback-text"));
    if (textarea) textarea.value = "";
  }

  _renderForm() {
    this.innerHTML = html`
      ${this.hasAttribute("hide-trigger")
        ? ""
        : html`<button
            class="feedback__open"
            id="feedback-open"
            type="button"
            aria-label="Send feedback about this app"
            title="Send feedback"
          >
            <wa-icon name="comment" aria-hidden="true"></wa-icon>
          </button>`}

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
              <wa-textarea
                id="feedback-text"
                class="feedback__textarea"
                name="message"
                rows="4"
                maxlength="2000"
                required
                placeholder="Share an idea, a bug, or a frustration…"
                label="Your feedback"
                resize="vertical"
              ></wa-textarea>
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
        </div>
      </dialog>
    `;
  }
}

customElements.define("feedback-dialog", FeedbackDialog);
