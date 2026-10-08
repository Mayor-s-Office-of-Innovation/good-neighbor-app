import "./timeline.css";
import "./task-update-dialog.css";
import {
  ApiError,
  createTaskUpdate,
  documentTaskUpdate,
  getMediaUrl,
  getTaskUpdates,
  uploadTaskUpdatePhoto,
} from "../services/api.js";
import { showTaskUpdateErrorToast } from "../state/toasts.js";
import { taskArtifactIds } from "../domain/home-tasks.js";
import { taskMediaUrl } from "../domain/task-media.js";
import {
  emptyTaskUpdateNotes,
  hasUnsavedTaskUpdateDraft,
  MAX_TASK_UPDATE_PHOTOS,
  MAX_TASK_UPDATE_TEXT,
} from "../domain/task-update-draft.js";
import {
  taskUpdateActionEditor,
  taskUpdateActionPhotos,
  taskUpdateCapture,
  taskUpdateDialogShell,
  taskUpdateNoteEditor,
  taskUpdateTimeline,
} from "./task-update-dialog.templates.js";

export class TaskUpdateDialog extends HTMLElement {
  constructor() {
    super();
    /** @type {Record<string, any> | null} */
    this._task = null;
    /** @type {Record<string, any> | null} */
    this._detail = null;
    this._savingNotes = false;
    this._results = false;
    this._mode = "timeline";
    /** @type {Record<string, any> | null} */
    this._pendingEvent = null;
    /** @type {File[]} */
    this._files = [];
    this._actionText = "";
    this._noteDrafts = emptyTaskUpdateNotes();
    this._noteIndex = 0;
    /** @type {string[]} */
    this._filePreviews = [];
    this._open = false;
    this._state = "idle";
    this._nextToken = null;
    /** @type {Map<File, Promise<string>>} */
    this._fileUploads = new Map();
    /** @type {Map<string, string>} */
    this._mediaUrls = new Map();
  }

  connectedCallback() {
    this._render();
  }

  /** @param {Record<string, any>} task */
  async open(task) {
    this._task = task;
    this._open = true;
    this._mode = "timeline";
    await this._load();
  }

  /** Collect documentation for the action that just completed this task.
   * @param {Record<string, any>} task
   */
  openResults(task) {
    this._resetDraft();
    this._task = task;
    this._results = true;
    this._pendingEvent = { updateId: task.latestUpdateId };
    this._mode = "notes";
    this._state = "ready";
    this._open = true;
    this._render();
  }

  /** @param {string} [nextToken] */
  async _load(nextToken = "") {
    if (!this._task) return;
    this._state = "loading";
    this._render();
    try {
      const page = await getTaskUpdates(
        this._task.taskId,
        nextToken || undefined,
      );
      this._detail = nextToken
        ? {
            ...page,
            updates: [
              ...(this._detail?.updates || []),
              ...(page.updates || []),
            ],
          }
        : page;
      this._nextToken = page.nextToken;
      this._task = this._detail.task;
      const photoIds = [
        ...new Set(
          [
            this._task.evidence?.artifactId || taskArtifactIds(this._task)[0],
            ...(this._detail.updates || []).flatMap(
              (update) => update.photoKeys || [],
            ),
          ].filter(Boolean),
        ),
      ];
      this._mediaUrls = new Map(
        await Promise.all(
          photoIds.map((artifactId) =>
            getMediaUrl(this._task.checkId, artifactId)
              .then(
                (media) =>
                  /** @type {[string, string]} */ ([
                    artifactId,
                    media.downloadUrl || "",
                  ]),
              )
              .catch(() => /** @type {[string, string]} */ ([artifactId, ""])),
          ),
        ),
      );
      this._state = "ready";
    } catch {
      this._state = "error";
    }
    this._render();
  }

  _content() {
    if (this._mode === "notes")
      return taskUpdateCapture({
        pendingEvent: this._pendingEvent,
        results: this._results,
        photosAllowed: this._task?.canUploadPhotos === true,
        files: this._files,
        notes: this._noteDrafts,
        previews: this._filePreviews,
      });
    if (this._mode === "note-text")
      return taskUpdateNoteEditor({ note: this._noteDrafts[this._noteIndex] });
    if (this._mode === "action")
      return taskUpdateActionEditor({ text: this._actionText });
    if (this._mode === "action-photos")
      return taskUpdateActionPhotos(
        this._filePreviews,
        this._files,
        this._task?.canUploadPhotos === true,
      );
    const task = this._task || {};
    return taskUpdateTimeline({
      task,
      updates: this._detail?.updates || [],
      issueOrigin: this._detail?.issueOrigin || "perimeter",
      originalMediaUrl: this._originalPhoto(task),
      mediaUrls: this._mediaUrls,
      nextToken: this._nextToken,
    });
  }

  _render() {
    this.innerHTML = taskUpdateDialogShell({
      mode: this._mode,
      state: this._state,
      content: this._state === "ready" ? this._content() : "",
    });
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("dialog.task-update")
    );
    if (!dialog) return;
    dialog
      .querySelector("[data-close]")
      ?.addEventListener("click", () => void this._close());
    dialog.querySelector("[data-back]")?.addEventListener("click", () => {
      this._mode = this._mode === "note-text" ? "notes" : "action";
      this._render();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      void this._close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) void this._close();
    });
    const discardDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("[data-discard-dialog]")
    );
    discardDialog
      ?.querySelector("[data-confirm-discard]")
      ?.addEventListener("click", () => {
        discardDialog.close();
        void this._close(true);
      });
    discardDialog
      ?.querySelector("[data-continue-editing]")
      ?.addEventListener("click", () => discardDialog.close());
    this._wire(dialog);
    if (this._open && !dialog.open) dialog.showModal();
  }

  /** @param {Record<string, any>} task */
  _originalPhoto(task) {
    return (
      taskMediaUrl(task) ||
      this._mediaUrls.get(
        task.evidence?.artifactId || taskArtifactIds(task)[0],
      ) ||
      ""
    );
  }

  /** @param {HTMLDialogElement} root */
  _wire(root) {
    root.querySelectorAll("[data-mode]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener("click", () => {
        this._mode = button.dataset.mode || "timeline";
        this._resetFiles();
        this._noteDrafts = emptyTaskUpdateNotes();
        this._render();
      });
    });
    root.querySelectorAll("[data-presence]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener(
        "click",
        () => void this._recordOutcome(root, button.dataset.presence || ""),
      );
    });
    root.querySelector("[data-load-older]")?.addEventListener("click", () => {
      if (this._nextToken) void this._load(this._nextToken);
    });
    root.querySelector("[data-photos]")?.addEventListener("change", (event) => {
      const input = /** @type {HTMLInputElement} */ (event.currentTarget);
      this._resetFiles();
      this._files = [...(input.files || [])].slice(0, MAX_TASK_UPDATE_PHOTOS);
      this._filePreviews = this._files.map((file) => URL.createObjectURL(file));
      this._render();
    });
    root
      .querySelector("[data-action-text]")
      ?.addEventListener("input", (event) => {
        const input = /** @type {HTMLTextAreaElement} */ (event.currentTarget);
        this._actionText = input.value.slice(0, MAX_TASK_UPDATE_TEXT);
        root.querySelectorAll("[data-action-outcome]").forEach((element) => {
          /** @type {HTMLButtonElement} */ (element).disabled =
            !this._actionText.trim();
        });
      });
    root.querySelector("[data-add-note]")?.addEventListener("click", () => {
      this._noteIndex = this._noteDrafts.findIndex((note) => !note.trim());
      this._mode = "note-text";
      this._render();
    });
    root.querySelectorAll("[data-edit-note]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener("click", () => {
        this._noteIndex = Number(button.dataset.editNote);
        this._mode = "note-text";
        this._render();
      });
    });
    root
      .querySelector("[data-note-text]")
      ?.addEventListener("input", (event) => {
        const input = /** @type {HTMLTextAreaElement} */ (event.currentTarget);
        this._noteDrafts[this._noteIndex] = input.value.slice(
          0,
          MAX_TASK_UPDATE_TEXT,
        );
        const save = /** @type {HTMLButtonElement | null} */ (
          root.querySelector("[data-save-note]")
        );
        if (save) save.disabled = !this._noteDrafts[this._noteIndex].trim();
      });
    root.querySelector("[data-clear-note]")?.addEventListener("click", () => {
      this._noteDrafts[this._noteIndex] = "";
      this._render();
    });
    root.querySelector("[data-save-note]")?.addEventListener("click", () => {
      this._mode = "notes";
      this._render();
    });
    root.querySelector("[data-clear]")?.addEventListener("click", () => {
      this._actionText = "";
      this._render();
    });
    root.querySelectorAll("[data-action-outcome]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener(
        "click",
        () =>
          void this._recordOutcome(
            root,
            button.dataset.actionOutcome || "",
            this._actionText.trim(),
          ),
      );
    });
    root
      .querySelector("[data-save-notes]")
      ?.addEventListener("click", () => void this._saveNotes(root));
    root
      .querySelector("[data-skip]")
      ?.addEventListener(
        "click",
        () => void this._finishDocumentation(root, [], []),
      );
    root
      .querySelector("[data-save-action]")
      ?.addEventListener("click", () => void this._saveAction(root));
    root
      .querySelector("[data-skip-action]")
      ?.addEventListener("click", () => void this._saveAction(root, true));
  }

  /** @returns {Promise<string[] | null>} */
  async _uploadFiles() {
    try {
      if (!this._task) return null;
      return await Promise.all(
        this._files.map((file) => this._uploadFile(file)),
      );
    } catch {
      showTaskUpdateErrorToast();
      return null;
    }
  }

  /** @param {File} file @returns {Promise<string>} */
  _uploadFile(file) {
    const cached = this._fileUploads.get(file);
    if (cached) return cached;
    const upload = uploadTaskUpdatePhoto(
      this._task.taskId,
      this._task.checkId,
      {
        file,
        capturedAt: new Date().toISOString(),
      },
    )
      .then((uploaded) => uploaded.artifactId)
      .catch((error) => {
        this._fileUploads.delete(file);
        throw error;
      });
    this._fileUploads.set(file, upload);
    return upload;
  }

  _resetFiles() {
    this._filePreviews.forEach((url) => URL.revokeObjectURL(url));
    this._filePreviews = [];
    this._files = [];
    this._fileUploads.clear();
  }

  /** @param {HTMLElement} root */
  async _saveNotes(root) {
    if (this._savingNotes || (this._results && !this._pendingEvent)) return;
    this._savingNotes = true;
    root.inert = true;
    try {
      if (!this._task) return;
      const notes = this._noteDrafts.map((note) => note.trim()).filter(Boolean);
      const photos = await this._uploadFiles();
      if (!photos || (!this._pendingEvent && !notes.length && !photos.length))
        return;
      if (this._pendingEvent)
        await this._finishDocumentation(root, notes, photos);
      else {
        const response = await this._runMutation(
          root,
          "[data-save-notes]",
          () =>
            createTaskUpdate(this._task.taskId, {
              type: "note_photo_update",
              notes,
              photoKeys: photos,
            }),
        );
        if (!response) return;
        this._resetFiles();
        this._mode = "timeline";
        await this._load();
        this._notifyUpdated();
      }
    } finally {
      this._savingNotes = false;
      root.inert = false;
    }
  }

  /** @param {HTMLElement} root @param {string[]} notes @param {string[]} photos */
  async _finishDocumentation(root, notes, photos) {
    if (!this._pendingEvent && this._results) {
      this._resetDraft();
      this._dismiss();
      return;
    }
    if (!this._task || !this._pendingEvent) return;
    const response = await this._runMutation(
      root,
      "[data-save-notes], [data-skip], [data-save-action], [data-skip-action]",
      () =>
        documentTaskUpdate(this._task.taskId, this._pendingEvent.updateId, {
          notes,
          photoKeys: photos,
        }),
    );
    if (!response) return;
    this._pendingEvent = null;
    this._resetDraft();
    this._mode = "timeline";
    if (this._results) this._dismiss();
    else await this._load();
  }

  /** @param {HTMLElement} root @param {string} type @param {string} [text] */
  async _recordOutcome(root, type, text) {
    const action = text !== undefined;
    if (!this._task || (action && !text)) return;
    const response = await this._runMutation(
      root,
      action ? "[data-action-outcome]" : "[data-presence]",
      () =>
        createTaskUpdate(this._task.taskId, {
          type,
          ...(action ? { text } : {}),
        }),
      !action,
    );
    if (!response) return;
    this._pendingEvent = response.update;
    this._task = response.task;
    this._mode = action ? "action-photos" : "notes";
    this._resetFiles();
    this._noteDrafts = emptyTaskUpdateNotes();
    this._render();
    this._notifyUpdated();
  }

  /** @param {HTMLElement} root @param {boolean} [skipPhotos] */
  async _saveAction(root, skipPhotos = false) {
    // The outcome step records the action before opening its photo editor.
    if (!this._task || !this._pendingEvent) return;
    const photos = skipPhotos ? [] : await this._uploadFiles();
    if (!photos) return;
    await this._finishDocumentation(root, [], photos);
    if (!this._pendingEvent) this._notifyUpdated();
  }

  /**
   * Run one dialog mutation with consistent busy and retry feedback.
   * @param {HTMLElement} root
   * @param {string} buttonSelector
   * @param {() => Promise<any>} action
   * @param {boolean} [reloadOnConflict]
   */
  async _runMutation(root, buttonSelector, action, reloadOnConflict = false) {
    const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (
      root.querySelectorAll(buttonSelector)
    );
    buttons.forEach((button) => (button.disabled = true));
    try {
      return await action();
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        /** @type {{ code?: string }} */ (caught.body)?.code ===
          "DocumentationConflict" &&
        this._results
      ) {
        this._pendingEvent = null;
        this._render();
        return null;
      }
      if (
        reloadOnConflict &&
        caught instanceof ApiError &&
        caught.status === 409
      ) {
        await this._load();
        return null;
      }
      showTaskUpdateErrorToast();
      return null;
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  }

  _hasUnsavedDraft() {
    return hasUnsavedTaskUpdateDraft(this._mode, {
      files: this._files,
      notes: this._noteDrafts,
      actionText: this._actionText,
    });
  }

  _showDiscard() {
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("[data-discard-dialog]")
    );
    if (dialog && !dialog.open) dialog.showModal();
  }

  /** @param {boolean} [discardConfirmed] */
  async _close(discardConfirmed = false) {
    if (this._savingNotes && !discardConfirmed) return;
    if (!discardConfirmed && this._hasUnsavedDraft()) {
      this._showDiscard();
      return;
    }
    if (this._results) {
      await this._finishDocumentation(
        /** @type {HTMLElement} */ (this.querySelector("dialog.task-update")),
        [],
        [],
      );
      return;
    }
    if (this._mode !== "timeline") {
      await this._sealPendingEvent();
      this._resetDraft();
      this._mode = "timeline";
      await this._load();
      return;
    }
    await this._sealPendingEvent();
    this._dismiss();
  }

  _dismiss() {
    this._results = false;
    this._open = false;
    /** @type {HTMLDialogElement | null} */ (
      this.querySelector("dialog.task-update")
    )?.close();
    this.dispatchEvent(new CustomEvent("taskupdateclosed", { bubbles: true }));
  }

  async _sealPendingEvent() {
    if (!this._pendingEvent || !this._task) return;
    await documentTaskUpdate(this._task.taskId, this._pendingEvent.updateId, {
      notes: [],
      photoKeys: [],
    }).catch(() => {});
    this._pendingEvent = null;
  }

  _resetDraft() {
    this._resetFiles();
    this._noteDrafts = emptyTaskUpdateNotes();
    this._noteIndex = 0;
    this._actionText = "";
  }

  _notifyUpdated() {
    this.dispatchEvent(new CustomEvent("taskupdated", { bubbles: true }));
  }
}

customElements.define("task-update-dialog", TaskUpdateDialog);
