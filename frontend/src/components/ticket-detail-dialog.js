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
import { analyzerTranslation } from "../i18n/analyzer-text.js";
import "./ticket-detail-dialog.css";
import { openOverlayDialog } from "../dialog-history.js";
import {
  get311RequestDetail,
  getTaskUpdates,
  getMediaUrl,
} from "../services/api.js";
import { submitted311Ticket } from "../domain/home-tasks.js";
import { ticketDetailLocation } from "../domain/ticket-detail.js";
import { taskMediaUrl } from "../domain/task-media.js";
import { showTaskUpdateErrorToast } from "../state/toasts.js";
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
  const analyzerText = (flat, key) => analyzerTranslation(task, key) ?? flat;
  return {
    ...request,
    title:
      task.userFriendlyLabel || task.user_friendly_label
        ? analyzerText(
            task.userFriendlyLabel || task.user_friendly_label,
            "user_friendly_label",
          )
        : rulebookText(task.category) ||
          rulebookText(task.analyzerCategory) ||
          request.problemType,
    description: analyzerText(
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
    this._editing = false;
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
      this._detail = { ...this._detail, task, mediaUrl: taskMediaUrl(task) };
      if (this.isConnected && !this._editing) this._render();
    }
  }

  /** @param {string} [nextToken] */
  async _load(nextToken) {
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
      const [response, page] = await Promise.all([
        get311RequestDetail(task.taskId, ticket.srNum),
        getTaskUpdates(task.taskId, nextToken),
      ]);
      const updates = [
        ...(nextToken ? this._detail?.updates || [] : []),
        ...(page.updates || []).filter(
          (update) =>
            update.type === "note_photo_update" ||
            update.type?.startsWith("additional_action"),
        ),
      ];
      const mediaUrls = new Map(
        await Promise.all(
          [...new Set(updates.flatMap((update) => update.photoKeys || []))].map(
            async (id) => {
              const media = await getMediaUrl(task.checkId, id).catch(
                () => null,
              );
              return /** @type {[string, string]} */ ([
                id,
                media?.downloadUrl || "",
              ]);
            },
          ),
        ),
      );
      if (!isCurrent()) return;
      this._task = { ...task, ...page.task };
      this._detail = {
        ...buildTicketDetail(this._task, this.site || {}, response.request),
        updates,
        mediaUrls,
        nextToken: page.nextToken,
        task: this._task,
      };
      this._state = "ready";
    } catch {
      if (!isCurrent()) return;
      this._state = "error";
    }
    this._render();
  }

  /** @param {string} mode */
  async _openEditor(mode) {
    if (
      this._editing ||
      !this._task ||
      this._task.status !== "in_progress" ||
      this._detail?.status === "Closed"
    )
      return;
    this._editing = true;
    try {
      await import("./task-update-dialog.js");
      if (!this._open) return;
      const editor =
        /** @type {import("./task-update-dialog.js").TaskUpdateDialog} */ (
          document.createElement("task-update-dialog")
        );
      let saved = false;
      editor.addEventListener("taskupdated", (event) => {
        event.stopPropagation();
        saved = true;
      });
      editor.addEventListener(
        "taskupdateclosed",
        async () => {
          editor.remove();
          this._editing = false;
          if (saved && this._open) await this._load();
          else if (this._open) this._render();
          /** @type {HTMLElement | null} */ (
            this.querySelector(`[data-mode="${mode}"]`)
          )?.focus();
        },
        { once: true },
      );
      document.body.append(editor);
      await editor.open(this._task, mode);
    } catch {
      this._editing = false;
      showTaskUpdateErrorToast();
    } finally {
      if (!this._open) this._editing = false;
    }
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
    dialog.querySelectorAll("[data-mode]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener(
        "click",
        () => void this._openEditor(button.dataset.mode || "notes"),
      );
    });
    dialog.querySelector("[data-load-older]")?.addEventListener("click", () => {
      if (this._detail?.nextToken) void this._load(this._detail.nextToken);
    });
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
