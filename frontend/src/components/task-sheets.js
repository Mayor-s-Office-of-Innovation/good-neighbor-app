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
import {
  holdCompletionCard,
  slideCompletedCard,
} from "./analysis-card-completion.js";
import { createTaskUpdate } from "../services/api.js";
import { showToast, showTaskUpdateErrorToast } from "../state/toasts.js";
import { t } from "../i18n/i18n.js";

/**
 * @typedef {object} TaskSheetsOptions
 * @property {boolean} [readOnly] informational timeline without mutation controls
 * @property {HTMLElement} host the view; cards are looked up inside it
 * @property {() => Element | null} container where the dialogs mount
 * @property {(task: Record<string, any>) => Record<string, any>} [resolveTask]
 *   the freshest copy of a task to hand a sheet (default: the task given)
 * @property {(task: Record<string, any>) => void} [onTaskUpdated]
 *   apply a confirmed task before reloading the host
 * @property {() => Promise<unknown> | void} [reload] re-render the host
 *   after a save or resolution; unchanged closes only restore focus
 * @property {() => HTMLElement | null} [fallbackFocus] focus target when
 *   neither the card button nor the trigger is still in the document
 */

export class TaskSheets {
  /** @param {TaskSheetsOptions} options */
  constructor(options) {
    this._options = options;
    /** @type {Map<string, Promise<{task: Record<string, any> | null}>>} */
    this._resolutions = new Map();
    /** Stable across uncertain HTTP retries. @type {Map<string, ReturnType<typeof crypto.randomUUID>>} */
    this._resolutionIds = new Map();
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
    void this._loadUpdates().catch(() => {});
    const container = this._options.container();
    if (!container) return;
    if (this._ticketDialog) {
      this._ticketDialog.site = this.site;
      container.append(this._ticketDialog);
    }
    if (this._updateDialog && this._updateDialog.parentElement !== container)
      container.append(this._updateDialog);
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
    if (this._options.readOnly) mode = "timeline";
    const completion =
      mode === "resolve" ? this._startResolution(task, trigger) : null;
    if (mode === "resolve" && !completion) return;
    const card = trigger?.closest?.(".analysis-card");
    const release = completion
      ? holdCompletionCard(this._options.host, card)
      : null;
    const finish = async (animate = false) => {
      if (!completion) return;
      try {
        const { task: saved } = await completion;
        if (saved) {
          if (animate && card?.isConnected) await slideCompletedCard(card);
          release?.();
          this._options.onTaskUpdated?.(saved);
        }
      } finally {
        release?.();
      }
    };
    this._updateReturnFocus = { taskId: task.taskId, trigger };
    try {
      await this._loadUpdates();
    } catch {
      await finish();
      if (completion) void this._options.reload?.();
      await this._formUnavailable(task, trigger, mode, completion);
      return;
    }
    if (
      this._updateDialog?._open &&
      (this._updateDialog._hasUnsavedDraft() ||
        this._updateDialog._task?.taskId !== task.taskId)
    ) {
      await finish();
      await this._formUnavailable(task, trigger, mode, completion, true);
      return;
    }
    if (!this._updateDialog) {
      const dialog = /** @type {any} */ (
        document.createElement("task-update-dialog")
      );
      dialog.addEventListener("taskresolve", (event) => {
        event.preventDefault();
        void this.openUpdates(
          event.detail,
          this._updateReturnFocus?.trigger || null,
          "resolve",
        );
      });
      let updateReload = Promise.resolve();
      dialog.addEventListener("taskupdated", (event) => {
        const task = /** @type {CustomEvent} */ (event).detail?.task;
        if (task) this._options.onTaskUpdated?.(task);
        updateReload = Promise.resolve(this._options.reload?.()).then(
          () => {},
          () => {},
        );
      });
      dialog.addEventListener("taskupdateclosed", async (event) => {
        // Resolution documentation may still be saving after dismissal.
        // Keep that controller single-use so another card cannot replace its state.
        if (/** @type {CustomEvent} */ (event).detail?.results) {
          dialog.remove();
          if (this._updateDialog === dialog) this._updateDialog = null;
        }
        const returnFocus = this._updateReturnFocus;
        this._updateReturnFocus = null;
        await dialog._finishResolution?.(true);
        const refresh = /** @type {CustomEvent} */ (event).detail?.results
          ? this._options.reload?.()
          : updateReload;
        void Promise.resolve(refresh).then(() => {
          this._focusCard(
            returnFocus?.taskId || "",
            "update",
            returnFocus?.trigger || null,
          );
        });
      });
      this._updateDialog = dialog;
    }
    this._updateDialog.readOnly = this._options.readOnly === true;
    this._updateDialog._finishResolution = finish;
    this.mount();
    if (completion || mode === "results")
      this._updateDialog.openResults(task, completion);
    else await this._updateDialog.open(this._resolve(task), mode);
  }

  /** Keep recovery local: no page reload and no discarded form drafts.
   * @param {Record<string, any>} task @param {HTMLElement | null} trigger
   * @param {string} mode @param {Promise<{task: Record<string, any> | null}> | null} completion
   * @param {boolean} [busy]
   */
  async _formUnavailable(task, trigger, mode, completion, busy = false) {
    const saved = completion ? (await completion).task : null;
    if (completion && !saved) return;
    showToast({
      title: t(
        busy
          ? "taskUpdate.finishCurrentForm"
          : saved || mode === "results"
            ? "taskUpdate.formUnavailableResolved"
            : "taskUpdate.formUnavailable",
      ),
      message: t("taskUpdate.formUnavailableHelp"),
      icon: "triangle-exclamation",
      tone: "error",
      duration: 0,
      action: {
        label: t("common.retry"),
        run: () => {
          void this.openUpdates(
            saved || task,
            trigger,
            saved ? "results" : mode,
          );
        },
      },
    });
  }

  _loadUpdates() {
    return import("./task-update-dialog.js");
  }

  /** Save independently of the optional dialog, with visible pending feedback.
   * @param {Record<string, any>} task @param {HTMLElement | null} trigger
   */
  _startResolution(task, trigger) {
    if (this._resolutions.has(task.taskId)) return null;
    const original = trigger?.textContent || "";
    const button = trigger instanceof HTMLButtonElement ? trigger : null;
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = t("taskUpdate.resolving");
    }
    const id = this._resolutionIds.get(task.taskId) || crypto.randomUUID();
    this._resolutionIds.set(task.taskId, id);
    const completion = createTaskUpdate(
      task.taskId,
      { type: "issue_resolved" },
      id,
    )
      .then((response) => {
        const saved = {
          ...task,
          ...response.task,
          latestUpdateId: response.update.updateId,
        };
        showToast({
          title: t("taskUpdate.siteResolved"),
          message: "",
          icon: "circle-check",
          tone: "success",
        });
        return { task: saved };
      })
      .catch((error) => {
        showTaskUpdateErrorToast(error, () => {
          void this.openUpdates(task, trigger, "resolve");
        });
        return { task: null };
      })
      .finally(() => {
        this._resolutions.delete(task.taskId);
        if (button) {
          button.disabled = false;
          button.removeAttribute("aria-busy");
          button.textContent = original;
        }
      });
    this._resolutions.set(task.taskId, completion);
    return completion;
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
