/*
  task-sheets — the two sheets a task card opens: the 311 request detail
  (<ticket-detail-dialog>) and the updates timeline (<task-update-dialog>).

  A host view that re-renders with innerHTML creates one TaskSheets, calls
  mount() after every render so the persistent dialog elements are
  re-appended (they restore their open state on reconnect), and routes its
  card buttons to open311() / openUpdates(). Focus returns to the card's
  current button once a sheet closes; the host says how to reload and where
  focus falls back to when the card is gone.
*/
import "./ticket-detail-dialog.js";

/**
 * @typedef {object} TaskSheetsOptions
 * @property {HTMLElement} host the view; cards are looked up inside it
 * @property {() => Element | null} container where the dialogs mount
 * @property {(task: Record<string, any>) => Record<string, any>} [resolveTask]
 *   the freshest copy of a task to hand a sheet (default: the task given)
 * @property {() => Promise<unknown> | void} [reload] re-render the host
 *   after the updates sheet saved or closed; focus is restored afterwards
 * @property {() => HTMLElement | null} [fallbackFocus] focus target when
 *   neither the card button nor the trigger is still in the document
 */

export class TaskSheets {
  /** @param {TaskSheetsOptions} options */
  constructor(options) {
    this._options = options;
    /** @type {Record<string, any> | null} the bound site, for the 311 sheet */
    this.site = null;
    /** @type {any} */
    this._ticketDialog = null;
    /** @type {any} */
    this._updateDialog = null;
    /** @type {{ taskId: string, trigger: HTMLElement | null } | null} */
    this._updateReturnFocus = null;
  }

  /** The task id the 311 sheet currently shows, if open. */
  get ticketTaskId() {
    return this._ticketDialog?.taskId || "";
  }

  /**
   * Re-append the persistent dialogs after the host re-rendered, and warm
   * the updates sheet's chunk so the first tap does not wait on it.
   */
  mount() {
    void import("./task-update-dialog.js");
    const container = this._options.container();
    if (!container) return;
    if (this._ticketDialog) {
      this._ticketDialog.site = this.site;
      container.append(this._ticketDialog);
    }
    if (this._updateDialog) container.append(this._updateDialog);
  }

  /** Hand the 311 sheet a fresher copy of its task (after hydration). */
  updateTask(task) {
    this._ticketDialog?.updateTask(task);
  }

  /**
   * @param {Record<string, any>} task
   * @param {HTMLElement | null} trigger
   */
  open311(task, trigger) {
    if (!this._ticketDialog) {
      const dialog = document.createElement("ticket-detail-dialog");
      dialog.addEventListener("ticketdetailclosed", (event) => {
        const { taskId, trigger } = /** @type {CustomEvent} */ (event).detail;
        this._focusCard(taskId, "view311", trigger);
      });
      this._ticketDialog = dialog;
    }
    this.mount();
    void this._ticketDialog.open(this._resolve(task), trigger);
  }

  /**
   * @param {Record<string, any>} task
   * @param {HTMLElement | null} trigger
   * @param {string} [mode]
   */
  async openUpdates(task, trigger, mode = "timeline") {
    this._updateReturnFocus = { taskId: task.taskId, trigger };
    await import("./task-update-dialog.js");
    if (!this._updateDialog) {
      const dialog = document.createElement("task-update-dialog");
      dialog.addEventListener("taskupdated", () => {
        void this._options.reload?.();
      });
      dialog.addEventListener("taskupdateclosed", (event) => {
        // Resolution documentation may still be saving after dismissal.
        // Keep that controller single-use so another card cannot replace its state.
        if (/** @type {CustomEvent} */ (event).detail?.results) {
          this._updateDialog.remove();
          this._updateDialog = null;
        }
        const returnFocus = this._updateReturnFocus;
        this._updateReturnFocus = null;
        void Promise.resolve(this._options.reload?.()).then(() => {
          this._focusCard(
            returnFocus?.taskId || "",
            "update",
            returnFocus?.trigger || null,
          );
        });
      });
      this._updateDialog = dialog;
    }
    this.mount();
    await this._updateDialog.open(this._resolve(task), mode);
  }

  /** @param {Record<string, any>} task */
  _resolve(task) {
    return this._options.resolveTask?.(task) || task;
  }

  /**
   * The card that opened the sheet was usually re-rendered since; find its
   * current button, then the original trigger, then the host's fallback.
   * @param {string} taskId
   * @param {string} action
   * @param {HTMLElement | null} trigger
   */
  _focusCard(taskId, action, trigger) {
    const current = taskId
      ? this._options.host.querySelector(
          `[data-task-id="${CSS.escape(taskId)}"] [data-action="${action}"]`,
        )
      : null;
    const target = /** @type {HTMLElement | null | undefined} */ (
      current ||
        (trigger?.isConnected ? trigger : null) ||
        this._options.fallbackFocus?.()
    );
    target?.focus?.();
  }
}
