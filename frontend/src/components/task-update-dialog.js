import { t } from "../i18n/i18n.js";
import {
  map311StatusResponse,
  taskWith311Status,
} from "../domain/task-311-status.js";
import { openOverlayDialog, onBackdropDismiss } from "../dialog-history.js";
import "./timeline.css";
import "./task-update-dialog.css";
import {
  createTaskUpdate,
  documentTaskUpdate,
  getMediaUrl,
  getTaskUpdates,
  get311RequestDetails,
  uploadTaskUpdatePhoto,
} from "../services/api.js";
import { showTaskUpdateErrorToast } from "../state/toasts.js";
import { taskArtifactIds, submitted311Ticket } from "../domain/home-tasks.js";
import { taskMediaUrl } from "../domain/task-media.js";
import {
  emptyTaskUpdateNotes,
  hasUnsavedTaskUpdateDraft,
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
  /** @type {boolean | undefined} */
  readOnly;
  constructor() {
    super();
    /** @type {Record<string, any> | null} */
    this._task = null;
    /** @type {Record<string, any> | null} */
    this._detail = null;
    this._saveController = null;
    this._activeSave = null;
    this._boundDialogs = new WeakSet();
    this._results = false;
    this._mode = "timeline";
    this._editorOnly = false;
    /** @type {boolean | null | undefined} */
    this._cityHelpNeeded = undefined;
    this._requests = new Map();
    this._cityUpdates = [];
    this._loadGeneration = 0;
    /** @type {Set<AbortController>} */
    this._timelineReads = new Set();
    this._timelineFrame = null;
    this._retryToken = "";
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

  /** @param {Record<string, any>} task @param {string} [mode] */
  async open(task, mode = "timeline") {
    if (mode === "resolve") {
      this.markResolved(task);
      return;
    }
    this._task = task;
    this._cityUpdates = [];
    this._detail = null;
    this._nextToken = null;
    this._mediaUrls.clear();
    this._results = false;
    this._pendingEvent = null;
    this._open = true;
    this._editorOnly = mode !== "timeline";
    this._mode = mode;
    this._resetDraft();
    await this._load();
  }

  /** Resolve immediately; documentation never holds the status update. */
  markResolved(task = this._task) {
    if (
      !task ||
      !(task.canUpdate ?? task.status === "in_progress") ||
      this._resolving
    )
      return;
    if (
      this.dispatchEvent(
        new CustomEvent("taskresolve", {
          cancelable: true,
          detail: task,
        }),
      ) === false
    )
      return;
    this._resolving = true;
    const completion = createTaskUpdate(task.taskId, { type: "issue_resolved" })
      .then((response) => {
        this._task = {
          ...task,
          ...response.task,
          latestUpdateId: response.update.updateId,
        };
        this._notifyUpdated();
        return { task: this._task };
      })
      .catch((error) => {
        showTaskUpdateErrorToast(error);
        return { task: null, failed: true };
      })
      .finally(() => {
        this._resolving = false;
      });
    void completion.then(({ task: saved }) => {
      if (saved) this._dismiss();
    });
  }

  /** Open proof with fresh photo permissions and task state. */
  async openProof(task) {
    await this.open(task, "proof");
  }

  /** @param {Record<string, any>} task */
  openResults(task) {
    ++this._loadGeneration;
    this._cancelTimelineReads();
    this._task = task;
    this._results = true;
    this._editorOnly = false;
    this._resetDraft();
    this._pendingEvent = {};
    this._mode = "notes";
    this._state = "ready";
    this._open = true;
    this._render();
  }

  _photosAllowed() {
    return this._task?.canUploadPhotos === true;
  }

  /** @param {string} [nextToken] */
  async _load(nextToken = "") {
    if (!this._task) return;
    const generation = ++this._loadGeneration;
    this._cancelTimelineReads();
    this._retryToken = nextToken;
    this._state = "loading";
    this._render();
    try {
      const page = await this._timelineRead((signal) =>
        getTaskUpdates(this._task.taskId, nextToken || undefined, { signal }),
      );
      if (generation !== this._loadGeneration) return;
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
      this._task = { ...this._task, ...this._detail.task };
      if (this._task.canRequestCityHelp === false)
        this._cityHelpNeeded = undefined;
      this._state = "ready";
      if (this._mode === "proof") {
        this.openResults(this._task);
        return;
      }
      this._render();
      void this._loadCityUpdates(generation);
      void this._loadTimelinePhotos(generation);
    } catch {
      if (generation !== this._loadGeneration) return;
      this._state = "error";
      this._render();
    }
  }

  async _loadCityUpdates(generation) {
    const ticket = submitted311Ticket(this._task);
    if (ticket) {
      try {
        const response = await this._timelineRead((signal) =>
          get311RequestDetails(
            [{ taskId: this._task.taskId, srNum: ticket.srNum }],
            { signal },
          ),
        );
        if (generation !== this._loadGeneration) return;
        this._task = taskWith311Status(
          this._task,
          map311StatusResponse(response),
        );
        const request = response.requests.find(
          (item) => item.taskId === this._task.taskId,
        )?.request;
        const seen = new Set();
        this._cityUpdates = (request?.events || [])
          .filter((event) => {
            if (event.kind === "submitted") return false;
            const key = JSON.stringify([
              event.kind,
              event.occurredAt,
              event.value,
              event.closureReason,
              event.notes,
              event.description,
            ]);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((event) => ({
            ...event,
            type: "city_status",
            label: event.title,
          }));
      } catch {
        // A City feed failure must not prevent access to the app's own timeline.
      }
    } else {
      this._cityUpdates = [];
      return;
    }

    if (generation === this._loadGeneration) this._refreshTimeline();
  }

  async _loadTimelinePhotos(generation) {
    const checkId = this._task.checkId;
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
    await Promise.all(
      photoIds.map(async (artifactId) => {
        try {
          const media = await this._timelineRead((signal) =>
            getMediaUrl(checkId, artifactId, { signal }),
          );
          if (generation !== this._loadGeneration) return;
          if (
            media.downloadUrl &&
            this._mediaUrls.get(artifactId) !== media.downloadUrl
          ) {
            this._mediaUrls.set(artifactId, media.downloadUrl);
            this._refreshTimeline();
          }
        } catch {
          // Optional evidence must never block the issue's activity timeline.
        }
      }),
    );
  }

  /** @template T @param {(signal: AbortSignal) => Promise<T>} read */
  async _timelineRead(read) {
    const controller = new AbortController();
    this._timelineReads.add(controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () =>
        reject(new DOMException("Timeline read cancelled", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([read(controller.signal), aborted]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      this._timelineReads.delete(controller);
    }
  }

  _cancelTimelineReads() {
    for (const controller of this._timelineReads) controller.abort();
    this._timelineReads.clear();
    if (this._timelineFrame !== null) cancelAnimationFrame(this._timelineFrame);
    this._timelineFrame = null;
  }

  _refreshTimeline() {
    if (this._timelineFrame !== null) return;
    const generation = this._loadGeneration;
    this._timelineFrame = requestAnimationFrame(() => {
      this._timelineFrame = null;
      if (generation === this._loadGeneration) this._renderTimeline();
    });
  }

  _renderTimeline() {
    // Background enrichment must not replace an editor or reopen a closed sheet.
    if (!this._open || this._mode !== "timeline" || this._state !== "ready")
      return;
    const dialog = this.querySelector?.("dialog.task-update");
    const scrollTop = dialog?.scrollTop || 0;
    const focused = globalThis.document?.activeElement;
    const marker =
      focused && dialog?.contains(focused)
        ? focused.hasAttribute("data-timeline-focus")
          ? "data-timeline-focus"
          : focused.getAttributeNames().find((name) => name.startsWith("data-"))
        : null;
    const selector = marker
      ? `[${marker}="${CSS.escape(focused.getAttribute(marker))}"]`
      : null;
    this._render();
    if (selector)
      /** @type {HTMLElement | null} */ (this.querySelector(selector))?.focus({
        preventScroll: true,
      });
    const replacement = this.querySelector?.("dialog.task-update");
    if (replacement) replacement.scrollTop = scrollTop;
  }

  _content() {
    if (this._mode === "notes")
      return taskUpdateCapture({
        pendingEvent: this._pendingEvent,
        results: this._results,
        task: this._results ? this._task : null,
        photosAllowed: this._photosAllowed(),
        files: this._files,
        notes: this._noteDrafts,
        previews: this._filePreviews,
        cityHelpNeeded: this._cityHelpNeeded,
      });
    if (this._mode === "note-text")
      return taskUpdateNoteEditor({ note: this._noteDrafts[this._noteIndex] });
    if (this._mode === "action")
      return taskUpdateActionEditor({
        text: this._actionText,
        allowResolution: this._cityHelpNeeded === undefined,
        cityHelpNeeded: this._cityHelpNeeded,
      });
    if (this._mode === "action-photos")
      return taskUpdateActionPhotos(
        this._filePreviews,
        this._files,
        this._task?.canUploadPhotos === true,
      );
    const task = this._task || {};
    return taskUpdateTimeline({
      task,
      updates: [...(this._detail?.updates || []), ...this._cityUpdates],
      issueOrigin: this._detail?.issueOrigin || "perimeter",
      originalMediaUrl:
        taskMediaUrl(task) ||
        this._mediaUrls.get(
          task.evidence?.artifactId || taskArtifactIds(task)[0],
        ) ||
        "",
      // The lightbox always opens the full-size original, never the card
      // thumbnail `taskMediaUrl` may have picked above.
      originalFullMediaUrl: task.mediaUrl || "",
      mediaUrls: this._mediaUrls,
      nextToken: this._nextToken,
      readOnly: this.readOnly,
    });
  }

  _render() {
    const markup = taskUpdateDialogShell({
      mode: this._mode,
      state: this._state,
      content: this._state === "ready" ? this._content() : "",
    });
    const existing = this.querySelector("dialog.task-update");
    if (existing) {
      // Preserve the native modal/top-layer identity when returning from the
      // mobile photo picker or switching editor modes.
      const template = document.createElement("template");
      template.innerHTML = markup;
      existing.replaceChildren(
        ...template.content.querySelector("dialog.task-update").childNodes,
      );
      const discard = this.querySelector("[data-discard-dialog]");
      if (discard)
        discard.replaceChildren(
          ...template.content.querySelector("[data-discard-dialog]").childNodes,
        );
    } else this.innerHTML = markup;
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
    if (!this._boundDialogs.has(dialog)) {
      this._boundDialogs.add(dialog);
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        void this._close();
      });
      onBackdropDismiss(dialog, () => void this._close());
    }
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
    if (this._busy) this._setSaveFeedback(dialog, t("care.saving"));
    if (this._open) {
      // Reattaching after a host render can retain `open` while losing the
      // browser's modal top layer. Restore it without firing a close event.
      if (dialog.open && !dialog.matches(":modal"))
        dialog.removeAttribute("open");
      if (this._editorOnly)
        openOverlayDialog(
          dialog,
          "task-update-editor",
          () => void this._close(),
        );
      else if (!dialog.open) dialog.showModal();
      this._settle();
    }
  }

  /**
   * The open transition is keyed off the host's `data-settled` attribute:
   * every render rebuilds the <dialog>, so without it the entrance would
   * replay on each state change while the sheet is up.
   */
  _settle() {
    // Optional chaining: the node unit tests stub HTMLElement bare.
    globalThis.requestAnimationFrame?.(() => {
      if (this._open) this.setAttribute?.("data-settled", "");
    });
  }

  /** @param {HTMLDialogElement} root */
  _wire(root) {
    root
      .querySelector("[data-cancel-save]")
      ?.addEventListener("click", () => this._saveController?.abort());
    root
      .querySelector("[data-retry-timeline]")
      ?.addEventListener("click", () => void this._load(this._retryToken));
    root.querySelectorAll("[data-city-help]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener("click", () => {
        if (this._busy) return;
        this._cityHelpNeeded = button.dataset.cityHelp === "yes";
        this._render();
        /** @type {HTMLButtonElement | null} */ (
          this.querySelector(`[data-city-help="${button.dataset.cityHelp}"]`)
        )?.focus();
      });
    });
    root.querySelectorAll("[data-mode]").forEach((element) => {
      const button = /** @type {HTMLButtonElement} */ (element);
      button.addEventListener("click", () => {
        if (button.dataset.mode === "resolve") {
          this.markResolved();
          return;
        }
        this._mode = button.dataset.mode || "timeline";
        this._resetDraft();
        this._render();
      });
    });
    root.querySelector("[data-load-older]")?.addEventListener("click", () => {
      if (this._nextToken) void this._load(this._nextToken);
    });
    root.querySelector("[data-take-photo]")?.addEventListener("click", () => {
      /** @type {HTMLInputElement | null} */ (
        root.querySelector("[data-photos]")
      )?.click();
    });
    root
      .querySelector("[data-upload-photos]")
      ?.addEventListener("click", () => {
        /** @type {HTMLInputElement | null} */ (
          root.querySelector("[data-upload-input]")
        )?.click();
      });
    root
      .querySelectorAll("[data-photos], [data-upload-input]")
      .forEach((element) => {
        const input = /** @type {HTMLInputElement} */ (element);
        input.addEventListener("change", () => {
          const selected = [...(input.files || [])];
          if (!selected.length) return;
          const files = [...this._files, ...selected];
          const invalid = selected.some(
            (file) =>
              !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name) ||
              (file.type &&
                ![
                  "image/jpeg",
                  "image/png",
                  "image/webp",
                  "image/heic",
                  "image/heif",
                ].includes(file.type)),
          );
          if (
            invalid ||
            files.length > 5 ||
            files.some((file) => !file.size || file.size > 10 * 1024 * 1024) ||
            files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024
          ) {
            const error = /** @type {HTMLElement | null} */ (
              root.querySelector("[data-photo-error]")
            );
            if (error) {
              error.hidden = false;
              error.textContent = t("taskUpdate.capture.photoLimits");
            }
            input.value = "";
            return;
          }
          this._files = files;
          this._filePreviews.push(
            ...selected.map((file) => URL.createObjectURL(file)),
          );
          this._render();
        });
      });
    root
      .querySelector("[data-action-text]")
      ?.addEventListener("input", (event) => {
        const input = /** @type {HTMLTextAreaElement} */ (event.currentTarget);
        this._actionText = input.value.slice(0, MAX_TASK_UPDATE_TEXT);
        root
          .querySelectorAll(".task-update__outcome button, [data-save-action]")
          .forEach((element) => {
            /** @type {HTMLButtonElement} */ (element).disabled =
              !this._actionText.trim() ||
              (element.hasAttribute("data-save-action") &&
                this._cityHelpNeeded === null);
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
    if (!this._task) return null;
    const button = /** @type {HTMLElement | null} */ (
      this.querySelector?.("[data-upload-photos]")
    );
    const status = /** @type {HTMLElement | null} */ (
      this.querySelector?.("[data-photo-upload-status]")
    );
    if (button) button.hidden = this._files.length > 0;
    if (status) status.hidden = this._files.length === 0;
    try {
      return await Promise.all(
        this._files.map((file) => this._uploadFile(file)),
      );
    } finally {
      if (button) button.hidden = false;
      if (status) status.hidden = true;
    }
  }

  /**
   * Passing `task` pins a background upload to the prompt it came from.
   * @param {File} file @param {Record<string, any>} [task]
   * @returns {Promise<string>}
   */
  _uploadFile(file, task = this._task) {
    const cached = this._fileUploads.get(file);
    if (cached) return cached;
    const signal = this._saveController?.signal;
    const forget = () => {
      if (this._fileUploads.get(file) === upload)
        this._fileUploads.delete(file);
    };
    const upload = uploadTaskUpdatePhoto(
      task.taskId,
      task.checkId,
      {
        file,
        capturedAt: new Date().toISOString(),
      },
      {
        signal,
        onProgress: (progress) => {
          const root = this.querySelector?.("dialog.task-update");
          if (root && this._busy && this._saveController?.signal === signal)
            this._setSaveFeedback(root, t("care.uploading", { progress }));
        },
      },
    )
      .then((uploaded) => uploaded.artifactId)
      .catch((error) => {
        forget();
        throw error;
      })
      .finally(() => signal?.removeEventListener("abort", forget));
    signal?.addEventListener("abort", forget, { once: true });
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
    if (
      !this._task ||
      this._busy ||
      this._cityHelpNeeded === null ||
      (this._results && !this._pendingEvent)
    )
      return;
    const notes = this._noteDrafts.map((note) => note.trim()).filter(Boolean);
    if (this._results) {
      await this._finishResults(notes, this._files);
      return;
    }
    const response = await this._runMutation(
      root,
      "[data-save-notes]",
      async (signal) => {
        const photos = await this._uploadFiles();
        signal.throwIfAborted();
        if (!photos || (!this._pendingEvent && !notes.length && !photos.length))
          return null;
        if (this._pendingEvent)
          return documentTaskUpdate(
            this._task.taskId,
            this._pendingEvent.updateId,
            { notes, photoKeys: photos },
            { signal: this._saveController?.signal },
          );
        return this._createUpdate({
          type: "note_photo_update",
          notes,
          photoKeys: photos,
        });
      },
    );
    if (response) {
      this._pendingEvent = null;
      await this._finishSave();
    }
  }

  /** Save proof before dismissing; failed saves keep the draft available.
   * @param {string[]} notes @param {File[]} files
   */
  async _finishResults(notes, files) {
    if (!notes.length && !files.length) {
      this._dismiss();
      return;
    }
    if (this._busy) return;
    return this._runMutation(
      this,
      "[data-save-notes], [data-skip]",
      async (signal) => {
        const photoKeys = await this._uploadFiles();
        signal.throwIfAborted();
        if (!photoKeys) return null;
        return this._createUpdate({
          type: "resolution_proof",
          notes,
          photoKeys,
        });
      },
    ).then((response) => {
      if (!response) return;
      this._task = { ...this._task, ...response.task };
      this._resetDraft();
      this._notifyUpdated();
      this._dismiss();
    });
  }

  /** @param {HTMLElement} root @param {string[]} notes @param {string[]} photos */
  async _finishDocumentation(root, notes, photos) {
    if (this._results) {
      await this._finishResults(notes, []);
      return;
    }
    if (!this._task || !this._pendingEvent) return;
    const response = await this._runMutation(
      root,
      "[data-save-notes], [data-skip], [data-save-action], [data-skip-action]",
      () =>
        documentTaskUpdate(
          this._task.taskId,
          this._pendingEvent.updateId,
          {
            notes,
            photoKeys: photos,
          },
          { signal: this._saveController?.signal },
        ),
    );
    if (!response) return;
    this._pendingEvent = null;
    this._resetDraft();
    this._mode = "timeline";
    await this._load();
  }

  /** @param {HTMLElement} root @param {string} type @param {string} [text] */
  async _recordOutcome(root, type, text) {
    if (!this._task || !text) return;
    const response = await this._runMutation(
      root,
      "[data-action-outcome]",
      () => this._createUpdate({ type, text }),
    );
    if (!response) return;
    this._pendingEvent = response.update;
    this._task = response.task;
    this._mode = "action-photos";
    this._resetFiles();
    this._noteDrafts = emptyTaskUpdateNotes();
    this._render();
    this._notifyUpdated();
  }

  /** @param {HTMLElement} root @param {boolean} [skipPhotos] */
  async _saveAction(root, skipPhotos = false) {
    if (!this._task || this._busy || this._cityHelpNeeded === null) return;
    const response = await this._runMutation(
      root,
      "[data-save-action], [data-skip-action]",
      async (signal) => {
        const photos = skipPhotos ? [] : await this._uploadFiles();
        signal.throwIfAborted();
        if (!photos) return null;
        if (this._pendingEvent)
          return documentTaskUpdate(
            this._task.taskId,
            this._pendingEvent.updateId,
            { notes: [], photoKeys: photos },
            { signal: this._saveController?.signal },
          );
        return this._createUpdate({
          type: "additional_action",
          text: this._actionText.trim(),
          photoKeys: photos,
        });
      },
    );
    if (response) {
      this._pendingEvent = null;
      await this._finishSave();
    }
  }

  /**
   * Keep retries of the same draft idempotent, including the City note.
   * @param {Record<string, unknown>} body
   */
  _createUpdate(body) {
    if (this._cityHelpNeeded !== undefined)
      body.cityHelpNeeded = this._cityHelpNeeded;
    const key = JSON.stringify(body);
    if (!this._requests.has(key)) this._requests.set(key, crypto.randomUUID());
    return createTaskUpdate(this._task.taskId, body, this._requests.get(key), {
      signal: this._saveController?.signal,
    });
  }

  async _finishSave() {
    this._mode = "timeline";
    this._resetDraft();
    if (this._editorOnly) {
      this._notifyUpdated();
      await this._close(true);
    } else {
      await this._load();
      this._notifyUpdated();
    }
  }

  /**
   * Run one dialog mutation with consistent busy and retry feedback.
   * @param {HTMLElement} root
   * @param {string} buttonSelector
   * @param {(signal: AbortSignal) => Promise<any>} action
   */
  async _runMutation(root, buttonSelector, action) {
    if (this._busy) return null;
    this._busy = true;
    const controller = new AbortController();
    this._saveController = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 120_000);
    this._setSaveFeedback(root, t("care.saving"));
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("Save cancelled", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    this._activeSave = Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return action(controller.signal);
      }),
      cancelled,
    ])
      .catch((error) => {
        if (!controller.signal.aborted || timedOut)
          showTaskUpdateErrorToast(error);
        return null;
      })
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        controller.abort(); // Also stop sibling uploads when one leg fails.
        this._busy = false;
        this._saveController = null;
        this._activeSave = null;
        this._setSaveFeedback(root, "");
      });
    return this._activeSave;
  }

  /** Keep the close/cancel controls outside the inert editor. */
  _setSaveFeedback(root, message) {
    const editor = root.querySelector?.(
      ".task-update__capture, .task-update__action",
    );
    if (editor) editor.inert = Boolean(message);
    const status = root.querySelector?.("[data-save-status]");
    if (status) status.textContent = message;
    const cancel = root.querySelector?.("[data-cancel-save]");
    if (cancel) cancel.hidden = !message;
    root.querySelectorAll?.("[data-back]").forEach((button) => {
      button.disabled = Boolean(message);
    });
  }

  _hasUnsavedDraft() {
    return (
      (this._mode !== "timeline" &&
        typeof this._cityHelpNeeded === "boolean") ||
      hasUnsavedTaskUpdateDraft(this._mode, {
        files: this._files,
        notes: this._noteDrafts,
        actionText: this._actionText,
      })
    );
  }

  _showDiscard() {
    const dialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("[data-discard-dialog]")
    );
    if (dialog && !dialog.open) dialog.showModal();
  }

  /** @param {boolean} [discardConfirmed] */
  async _close(discardConfirmed = false) {
    if (this._saveController) {
      this._saveController.abort();
      await this._activeSave;
    }
    if (this._busy) return;
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
    if (this._mode !== "timeline" && !this._editorOnly) {
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
    const results = this._results;
    ++this._loadGeneration;
    this._cancelTimelineReads();
    this._resetDraft();
    this._results = false;
    this._editorOnly = false;
    this._open = false;
    this.removeAttribute?.("data-settled");
    /** @type {HTMLDialogElement | null} */ (
      this.querySelector("dialog.task-update")
    )?.close();
    this.dispatchEvent(
      new CustomEvent("taskupdateclosed", {
        bubbles: true,
        detail: { results },
      }),
    );
  }

  async _sealPendingEvent() {
    if (!this._pendingEvent || !this._task) return;
    await documentTaskUpdate(
      this._task.taskId,
      this._pendingEvent.updateId,
      {
        notes: [],
        photoKeys: [],
      },
      { signal: AbortSignal.timeout(15_000) },
    ).catch(() => {});
    this._pendingEvent = null;
  }

  _resetDraft() {
    this._cityHelpNeeded =
      !this._results &&
      (this._task?.canRequestCityHelp ??
        Boolean(submitted311Ticket(this._task)))
        ? null
        : undefined;
    this._requests.clear();
    this._resetFiles();
    this._noteDrafts = emptyTaskUpdateNotes();
    this._noteIndex = 0;
    this._actionText = "";
  }

  _notifyUpdated() {
    this.dispatchEvent(
      new CustomEvent("taskupdated", {
        bubbles: true,
        detail: { task: this._task },
      }),
    );
  }
}

customElements.define("task-update-dialog", TaskUpdateDialog);
