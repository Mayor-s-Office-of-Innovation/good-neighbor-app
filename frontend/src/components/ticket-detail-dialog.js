/*
  ticket-detail-dialog — the 311 request detail sheet opened from a task card
  on the home hub.

  today-view creates one instance, keeps it across its own re-renders (it
  re-appends the same element after each innerHTML replacement), and calls
  open(task, trigger). The element owns the fetch, the loading / error /
  ready states, and the native <dialog>; it restores its open state whenever
  it is re-rendered or re-attached. On close it dispatches a bubbling
  "ticketdetailclosed" event carrying the task id and the original trigger so
  the host can return focus to the right card button.
*/
import "./timeline.css";
import { rulebookText } from "../i18n/rulebook.js";
import { localizedAnalyzerText } from "../i18n/analyzer.js";
import "./ticket-detail-dialog.css";
import { openOverlayDialog } from "../dialog-history.js";
import { get311RequestDetail } from "../services/api.js";
import { submitted311Ticket } from "../domain/home-tasks.js";
import { ticketDetailLocation } from "../domain/ticket-detail.js";
import { taskMediaUrl } from "../domain/task-media.js";
import { ticketDetailDialog } from "./ticket-detail-dialog.templates.js";

/**
 * Merge a task card's own fields over the 311 request record for display.
 * Exported pure so the node test can cover the precedence rules.
 * @param {Record<string, any>} task
 * @param {Record<string, any>} site
 * @param {Record<string, any>} request
 * @returns {Record<string, any>}
 */
export function buildTicketDetail(task, site, request) {
  return {
    ...request,
    title:
      task.userFriendlyLabel || task.user_friendly_label
        ? localizedAnalyzerText(
            task,
            task.userFriendlyLabel || task.user_friendly_label,
            "user_friendly_label",
          )
        : rulebookText(task.category) ||
          rulebookText(task.analyzerCategory) ||
          request.problemType,
    description: localizedAnalyzerText(
      task,
      task.description || request.description || "",
      "description",
    ),
    location: ticketDetailLocation(task, site || {}, request),
    mediaUrl: taskMediaUrl(task),
  };
}

class TicketDetailDialog extends HTMLElement {
  constructor() {
    super();
    /** @type {Record<string, any> | null} the bound site, set by the host */
    this.site = null;
    this._task = null;
    this._trigger = null;
    this._detail = null;
    this._state = "idle";
    this._open = false;
    this._generation = 0;
  }

  /** @returns {string} */
  get taskId() {
    return this._task?.taskId || "";
  }

  connectedCallback() {
    this._render();
  }

  /**
   * Open the sheet for a task and load its 311 request.
   * @param {Record<string, any>} task
   * @param {EventTarget | null} [trigger] control that opened it, for focus return
   */
  async open(task, trigger = null) {
    this._task = task;
    this._trigger = trigger;
    this._open = true;
    this._detail = null;
    await this._load();
  }

  /**
   * Swap in a fresher copy of the open task (e.g. after evidence hydration
   * attached its photo) without reloading the request.
   * @param {Record<string, any> | null | undefined} task
   */
  updateTask(task) {
    if (!task || !this._task || task.taskId !== this._task.taskId) return;
    if (document.querySelector("photo-lightbox dialog[open]")) {
      this._pendingTask = task;
      document.addEventListener(
        "photolightboxclosed",
        () => {
          const pendingTask = this._pendingTask;
          this._pendingTask = null;
          this.updateTask(pendingTask);
        },
        { once: true },
      );
      return;
    }
    this._task = task;
    if (this._detail) {
      this._detail = { ...this._detail, mediaUrl: taskMediaUrl(task) };
      if (this.isConnected) this._render();
    }
  }

  async _load() {
    const task = this._task;
    const ticket = submitted311Ticket(task);
    if (!task || !ticket) return;
    const generation = ++this._generation;
    const isCurrent = () =>
      generation === this._generation &&
      task.taskId === this._task?.taskId &&
      ticket.srNum === submitted311Ticket(this._task)?.srNum;
    this._state = "loading";
    this._render();
    try {
      const response = await get311RequestDetail(task.taskId, ticket.srNum);
      if (!isCurrent()) return;
      this._detail = buildTicketDetail(task, this.site || {}, response.request);
      this._state = "ready";
    } catch {
      if (!isCurrent()) return;
      this._state = "error";
    }
    this._render();
  }

  _render() {
    this.innerHTML = ticketDetailDialog({
      detail: this._detail,
      state: this._state,
    });
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#ticket-detail-dialog")
    );
    if (!dialog) return;
    dialog
      .querySelector("[data-close-311]")
      ?.addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-retry-311]")?.addEventListener("click", () => {
      void this._load();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      this._open = false;
      this._generation += 1;
      this.dispatchEvent(
        new CustomEvent("ticketdetailclosed", {
          bubbles: true,
          detail: { taskId: this.taskId, trigger: this._trigger },
        }),
      );
    });
    if (this._open) openOverlayDialog(dialog, "ticket-detail");
  }
}

customElements.define("ticket-detail-dialog", TicketDetailDialog);

export { TicketDetailDialog };
