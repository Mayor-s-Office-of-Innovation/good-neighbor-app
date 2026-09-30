// @ts-nocheck -- custom-element DOM state is runtime-validated at each boundary.
import "./timeline.css";
import "./task-update-dialog.css";
import {
  createTaskUpdate,
  documentTaskUpdate,
  getMediaUrl,
  getTaskUpdates,
  uploadTaskUpdatePhoto,
} from "../services/api.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { formatPacificDateTime } from "../domain/task-updates.js";
import { taskArtifactIds } from "../domain/home-tasks.js";
import { taskMediaUrl } from "./analysis-results.templates.js";

const MAX_PHOTOS = 6;
const MAX_NOTES = 3;
const MAX_TEXT = 4000;

class TaskUpdateDialog extends HTMLElement {
  constructor() {
    super();
    this._task = null;
    this._detail = null;
    this._mode = "timeline";
    this._pendingEvent = null;
    this._files = [];
    this._actionText = "";
    this._noteDrafts = ["", "", ""];
    this._noteIndex = 0;
    this._filePreviews = [];
    this._open = false;
    this._mediaUrls = new Map();
  }

  connectedCallback() {
    this._render();
  }

  async open(task) {
    this._task = task;
    this._open = true;
    this._mode = "timeline";
    await this._load();
  }

  async _load() {
    this._state = "loading";
    this._render();
    try {
      this._detail = await getTaskUpdates(this._task.taskId);
      this._task = this._detail.task;
      const photoIds = [
        ...new Set(
          [
            this._task.evidence?.artifactId,
            ...taskArtifactIds(this._task),
            ...(this._detail.updates || []).flatMap(
              (update) => update.photoKeys || [],
            ),
          ].filter(Boolean),
        ),
      ];
      this._mediaUrls = new Map(
        await Promise.all(
          photoIds.map(async (artifactId) => {
            try {
              const media = await getMediaUrl(this._task.checkId, artifactId);
              return [artifactId, media.downloadUrl || ""];
            } catch {
              return [artifactId, ""];
            }
          }),
        ),
      );
      this._state = "ready";
    } catch {
      this._state = "error";
    }
    this._render();
  }

  _render() {
    const task = this._task || {};
    const detail = this._detail || { updates: [] };
    this.innerHTML = html`<dialog
        class="task-update"
        aria-labelledby="task-update-title"
      >
        <div class="task-update__sheet">
          <header class="task-update__header">
            ${this._mode === "note-text" ||
            (this._mode === "action-photos" && !this._pendingEvent)
              ? html`<button
                  type="button"
                  class="btn-icon wa-plain"
                  data-back
                  aria-label="Back"
                >
                  <wa-icon name="chevron-left"></wa-icon>
                </button>`
              : html`<span></span>`}
            <button
              type="button"
              class="btn-icon wa-plain"
              data-close
              aria-label="Close"
            >
              <wa-icon name="xmark"></wa-icon>
            </button>
          </header>
          ${this._state === "loading"
            ? html`<p role="status">Loading updates…</p>`
            : ""}
          ${this._state === "error"
            ? html`<p role="alert">
                We couldn't load this issue. Please try again.
              </p>`
            : ""}
          ${this._state === "ready"
            ? this._content(task, detail.updates || [])
            : ""}
        </div>
      </dialog>
      <dialog
        class="task-update__discard-dialog"
        aria-labelledby="task-update-discard-title"
        data-discard-dialog
      >
        <div class="task-update__discard-card">
          <h2 id="task-update-discard-title">
            Closing will discard what you've added
          </h2>
          <div class="task-update__discard-actions">
            <button
              type="button"
              class="task-update__discard-confirm"
              data-confirm-discard
            >
              Discard and close
            </button>
            <button type="button" class="btn-outline" data-continue-editing>
              Back to editing
            </button>
          </div>
        </div>
      </dialog>`;
    const dialog = this.querySelector("dialog");
    if (!dialog) return;
    dialog
      .querySelector("[data-close]")
      ?.addEventListener("click", () => this._close());
    dialog.querySelector("[data-back]")?.addEventListener("click", () => {
      this._mode =
        this._mode === "note-text"
          ? this._pendingEvent
            ? "document"
            : "notes"
          : "action";
      this._render();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this._close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) this._close();
    });
    const discardDialog = this.querySelector("[data-discard-dialog]");
    discardDialog
      ?.querySelector("[data-confirm-discard]")
      ?.addEventListener("click", () => {
        discardDialog.close();
        this._close(true);
      });
    discardDialog
      ?.querySelector("[data-continue-editing]")
      ?.addEventListener("click", () => discardDialog.close());
    this._wire(dialog);
    if (this._open && !dialog.open) dialog.showModal();
  }

  _content(task, updates) {
    if (this._mode === "notes" || this._mode === "document")
      return this._capture();
    if (this._mode === "note-text") return this._noteText();
    if (this._mode === "action") return this._action();
    if (this._mode === "action-photos") return this._actionPhotos();
    const expected = task.responseExpectedAt
      ? new Date(task.responseExpectedAt)
      : null;
    const overdue = expected && expected.getTime() < Date.now();
    const latestUpdateLabel = String(task.latestUpdateLabel || "").trim();
    const timeline = [
      ...updates,
      {
        type: "issue_created",
        label:
          this._detail?.issueOrigin === "single-problem"
            ? "Issue added as a single issue"
            : "Issue added during a perimeter check",
        occurredAt: task.createdAt || task.created_at || task.notifiedAt,
      },
    ].filter((update) => update.occurredAt);
    return html` <section class="task-update__summary">
        <p
          class="task-update__route${latestUpdateLabel
            ? ""
            : " task-update__route--bare"}"
        >
          ${escapeHtml(
            task.kind === "escalation"
              ? "311 request"
              : task.inProgressActionKind === "called_911"
                ? "Emergency call"
                : "Non-emergency call",
          )}${latestUpdateLabel
            ? html` · <strong>${escapeHtml(latestUpdateLabel)}</strong>`
            : ""}
        </p>
        <p class="task-update__location">
          ${escapeHtml(
            String(
              task.georeferencedAddress ||
                task.siteAddress ||
                task.address ||
                "",
            ).split(/\r?\n|,/)[0],
          )}
        </p>
        <h2 id="task-update-title">
          ${escapeHtml(
            task.userFriendlyLabel || task.category || "Issue update",
          )}
        </h2>
        <p class="task-update__description">
          ${escapeHtml(task.description || "")}
        </p>
        ${this._originalMediaUrl(task)
          ? html`<img
              class="task-update__photo task-update__photo--original"
              src="${escapeAttr(this._originalMediaUrl(task))}"
              alt="Evidence for ${escapeAttr(
                task.userFriendlyLabel || task.category || "this issue",
              )}"
            />`
          : ""}
        <dl class="task-update__metadata">
          <div>
            <dt>Agency:</dt>
            <dd>${escapeHtml(task.agency || "unknown")}</dd>
          </div>
          <div>
            <dt>Notified:</dt>
            <dd>
              ${escapeHtml(
                task.notifiedAt
                  ? formatPacificDateTime(task.notifiedAt)
                  : "unknown",
              )}
            </dd>
          </div>
          ${expected
            ? html`<div>
                <dt>Response expected by:</dt>
                <dd>${escapeHtml(formatPacificDateTime(expected))}</dd>
              </div>`
            : ""}
        </dl>
        ${overdue && task.status !== "completed" && !task.resolvedAt
          ? html`<p class="task-update__overdue">
              <strong>Expected response time has passed</strong>
            </p>`
          : ""}
      </section>
      ${task.presencePromptDue
        ? html`<section class="task-update__prompt">
            <h3>Is the issue still there?</h3>
            <div class="task-update__actions">
              <button
                type="button"
                class="btn-theme wa-success wa-accent wa-pill"
                data-presence="presence_resolved"
              >
                Resolved</button
              ><button
                type="button"
                class="btn-theme wa-neutral wa-filled wa-pill"
                data-presence="presence_still_present"
              >
                Still there
              </button>
            </div>
          </section>`
        : ""}
      ${task.status === "in_progress"
        ? html`<section class="task-update__section">
            <h3>Updates</h3>
            <div class="task-update__actions">
              <button
                type="button"
                class="${task.presencePromptDue
                  ? "btn-outline btn-outline--sm"
                  : "btn-ink btn-ink--sm"}"
                data-mode="notes"
              >
                Add a note or photo</button
              ><button
                type="button"
                class="${task.presencePromptDue
                  ? "btn-outline btn-outline--sm"
                  : "btn-ink btn-ink--sm"}"
                data-mode="action"
              >
                Record an action
              </button>
            </div>
          </section>`
        : html`<h3 class="task-update__updates-title">Updates</h3>`}
      <ol class="ticket-timeline task-update__timeline">
        ${timeline
          .map(
            (update) =>
              html`<li
                class="ticket-timeline__item task-update__timeline-item task-update__timeline-item--${this._timelineTone(
                  update.type,
                )}"
              >
                <div class="ticket-timeline__content">
                  <strong>${escapeHtml(update.label)}</strong
                  ><time datetime="${escapeAttr(update.occurredAt)}"
                    >${escapeHtml(
                      formatPacificDateTime(update.occurredAt),
                    )}</time
                  >${update.text
                    ? html`<p>${escapeHtml(update.text)}</p>`
                    : ""}${(update.notes || [])
                    .map((note) => html`<p>${escapeHtml(note)}</p>`)
                    .join("")}${(update.photoKeys || [])
                    .map((artifactId) =>
                      this._mediaUrls.get(artifactId)
                        ? html`<img
                            class="task-update__photo"
                            src="${escapeAttr(this._mediaUrls.get(artifactId))}"
                            alt="Update photo for ${escapeAttr(
                              task.userFriendlyLabel ||
                                task.category ||
                                "this issue",
                            )}"
                          />`
                        : "",
                    )
                    .join("")}
                </div>
              </li>`,
          )
          .join("")}
      </ol>
      <p>#${escapeHtml(task.shortId || task.taskId || "")}</p>`;
  }

  _timelineTone(type) {
    if (type === "escalation_action_taken") return "escalation";
    if (
      type === "presence_still_present" ||
      type === "additional_action_still_present"
    )
      return "still-there";
    if (type === "presence_resolved" || type === "additional_action_resolved")
      return "resolved";
    return "general";
  }

  _capture() {
    const title =
      this._pendingEvent?.type === "presence_resolved"
        ? "Document your success"
        : this._pendingEvent
          ? "Update this issue with a photo"
          : "Add a photo or note to this issue";
    const hasContent =
      this._files.length || this._noteDrafts.some((note) => note.trim());
    return html`<section class="task-update__capture">
      <h2 id="task-update-title">${title}</h2>
      <div class="task-update__photo-grid">
        <label class="task-update__photo-picker"
          ><input
            class="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            multiple
            data-photos
          /><span class="task-update__camera" aria-hidden="true"
            ><wa-icon name="camera"></wa-icon></span
          ><span>Add a photo</span></label
        >${this._filePreviews
          .map(
            (url, i) =>
              html`<img
                class="task-update__photo task-update__photo--draft"
                src="${escapeAttr(url)}"
                alt="Selected update photo ${i + 1}"
              />`,
          )
          .join("")}
      </div>
      ${this._noteDrafts.filter((note) => note.trim()).length
        ? html`<ul class="task-update__note-list">
            ${this._noteDrafts
              .map((note, i) =>
                note.trim()
                  ? html`<li>
                      <button type="button" data-edit-note="${i}">
                        ${escapeHtml(note)}
                      </button>
                    </li>`
                  : "",
              )
              .join("")}
          </ul>`
        : ""}${this._noteDrafts.filter((note) => note.trim()).length < MAX_NOTES
        ? html`<button
            type="button"
            class="btn-outline task-update__add-note"
            data-add-note
          >
            Add a typed note
          </button>`
        : ""}
      <p class="task-update__error" role="alert" hidden></p>
      <div class="task-update__actions task-update__actions--footer">
        <button
          type="button"
          class="btn-ink"
          data-save-notes
          ${!this._pendingEvent && !hasContent ? "disabled" : ""}
        >
          Done</button
        >${this._pendingEvent
          ? html`<button type="button" class="btn-outline" data-skip>
              Skip
            </button>`
          : ""}
      </div>
    </section>`;
  }

  _noteText() {
    return html`<section
      class="task-update__capture task-update__capture--text"
    >
      <h2 id="task-update-title">Add a typed note</h2>
      <div class="task-update__text-card">
        <textarea
          class="task-update__text-field"
          maxlength="${MAX_TEXT}"
          data-note-text
          aria-label="Typed note"
        >
${escapeHtml(this._noteDrafts[this._noteIndex])}</textarea
        ><button type="button" class="task-update__clear" data-clear-note>
          Clear all
        </button>
      </div>
      <button
        type="button"
        class="btn-ink task-update__next"
        data-save-note
        ${this._noteDrafts[this._noteIndex].trim() ? "" : "disabled"}
      >
        Continue
      </button>
    </section>`;
  }

  _action() {
    return html`<section
      class="task-update__capture task-update__capture--text"
    >
      <h2 id="task-update-title">Share a follow up action</h2>
      <p class="task-update__subtitle">
        Describe what else you did to address this issue.
      </p>
      <div class="task-update__text-card">
        <textarea
          class="task-update__text-field"
          maxlength="${MAX_TEXT}"
          data-action-text
          aria-label="Follow up action"
        >
${escapeHtml(this._actionText)}</textarea
        ><button type="button" class="task-update__clear" data-clear>
          Clear all
        </button>
      </div>
      <section class="task-update__outcome">
        <h3>Did this action resolve the issue?</h3>
        <div class="task-update__actions">
          <button
            type="button"
            class="btn-theme wa-success wa-accent wa-pill"
            data-action-outcome="additional_action_resolved"
            ${this._actionText.trim() ? "" : "disabled"}
          >
            Resolved</button
          ><button
            type="button"
            class="btn-theme wa-neutral wa-filled wa-pill"
            data-action-outcome="additional_action_still_present"
            ${this._actionText.trim() ? "" : "disabled"}
          >
            Still there
          </button>
        </div>
      </section>
      <p class="task-update__error" role="alert" hidden></p>
    </section>`;
  }

  _actionPhotos() {
    return html`<section class="task-update__capture">
      <h2 id="task-update-title">Document your action</h2>
      <div class="task-update__photo-grid">
        <label class="task-update__photo-picker"
          ><input
            class="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            multiple
            data-photos
          /><span class="task-update__camera" aria-hidden="true"
            ><wa-icon name="camera"></wa-icon></span
          ><span>Add a photo</span></label
        >${this._filePreviews
          .map(
            (url, i) =>
              html`<img
                class="task-update__photo task-update__photo--draft"
                src="${escapeAttr(url)}"
                alt="Selected action photo ${i + 1}"
              />`,
          )
          .join("")}
      </div>
      <p class="task-update__error" role="alert" hidden></p>
      <div class="task-update__actions task-update__actions--footer">
        <button
          type="button"
          class="btn-ink"
          data-save-action
          ${this._files.length ? "" : "disabled"}
        >
          Done</button
        ><button type="button" class="btn-outline" data-skip-action>
          Skip
        </button>
      </div>
    </section>`;
  }

  _originalMediaUrl(task) {
    const embedded = taskMediaUrl(task);
    if (embedded) return embedded;
    const artifactId = task.evidence?.artifactId || taskArtifactIds(task)[0];
    return artifactId ? this._mediaUrls.get(artifactId) || "" : "";
  }

  _wire(root) {
    root.querySelectorAll("[data-mode]").forEach((button) =>
      button.addEventListener("click", () => {
        this._mode = button.dataset.mode;
        this._resetFiles();
        this._noteDrafts = ["", "", ""];
        this._render();
      }),
    );
    root.querySelectorAll("[data-presence]").forEach((button) =>
      button.addEventListener("click", async () => {
        button.disabled = true;
        const response = await createTaskUpdate(this._task.taskId, {
          type: button.dataset.presence,
        });
        this._pendingEvent = response.update;
        this._task = response.task;
        this._mode = "document";
        this._resetFiles();
        this._noteDrafts = ["", "", ""];
        this._render();
        this.dispatchEvent(new CustomEvent("taskupdated", { bubbles: true }));
      }),
    );
    root.querySelector("[data-photos]")?.addEventListener("change", (event) => {
      this._filePreviews.forEach((url) => URL.revokeObjectURL(url));
      this._files = [...event.target.files].slice(0, MAX_PHOTOS);
      this._filePreviews = this._files.map((file) => URL.createObjectURL(file));
      this._render();
    });
    root
      .querySelector("[data-action-text]")
      ?.addEventListener("input", (event) => {
        this._actionText = event.target.value.slice(0, MAX_TEXT);
        root.querySelectorAll("[data-action-outcome]").forEach((button) => {
          button.disabled = !this._actionText.trim();
        });
      });
    root.querySelector("[data-add-note]")?.addEventListener("click", () => {
      this._noteIndex = this._noteDrafts.findIndex((note) => !note.trim());
      this._mode = "note-text";
      this._render();
    });
    root.querySelectorAll("[data-edit-note]").forEach((button) =>
      button.addEventListener("click", () => {
        this._noteIndex = Number(button.dataset.editNote);
        this._mode = "note-text";
        this._render();
      }),
    );
    root
      .querySelector("[data-note-text]")
      ?.addEventListener("input", (event) => {
        this._noteDrafts[this._noteIndex] = event.target.value.slice(
          0,
          MAX_TEXT,
        );
        const save = root.querySelector("[data-save-note]");
        if (save) save.disabled = !this._noteDrafts[this._noteIndex].trim();
      });
    root.querySelector("[data-clear-note]")?.addEventListener("click", () => {
      this._noteDrafts[this._noteIndex] = "";
      this._render();
    });
    root.querySelector("[data-save-note]")?.addEventListener("click", () => {
      this._mode = this._pendingEvent ? "document" : "notes";
      this._render();
    });
    root.querySelector("[data-clear]")?.addEventListener("click", () => {
      this._actionText = "";
      this._render();
    });
    root
      .querySelectorAll("[data-action-outcome]")
      .forEach((button) =>
        button.addEventListener("click", () =>
          this._recordActionOutcome(root, button.dataset.actionOutcome),
        ),
      );
    root
      .querySelector("[data-save-notes]")
      ?.addEventListener("click", () => this._saveNotes(root));
    root
      .querySelector("[data-skip]")
      ?.addEventListener("click", () => this._finishDocumentation([], []));
    root
      .querySelectorAll("[data-save-action]")
      .forEach((button) =>
        button.addEventListener("click", () => this._saveAction(root)),
      );
    root
      .querySelector("[data-skip-action]")
      ?.addEventListener("click", () => this._saveAction(root, true));
  }

  async _uploadFiles(root) {
    const error = root.querySelector(".task-update__error");
    try {
      return await Promise.all(
        this._files.map(async (file) => {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const uploaded = await uploadTaskUpdatePhoto(
            this._task.taskId,
            this._task.checkId,
            { dataUrl, capturedAt: new Date().toISOString() },
          );
          return uploaded.artifactId;
        }),
      );
    } catch {
      error.hidden = false;
      error.textContent = "Could not upload the photos. Please try again.";
      return null;
    }
  }

  _resetFiles() {
    this._filePreviews.forEach((url) => URL.revokeObjectURL(url));
    this._filePreviews = [];
    this._files = [];
  }

  async _saveNotes(root) {
    const notes = this._noteDrafts.map((note) => note.trim()).filter(Boolean);
    const photos = await this._uploadFiles(root);
    if (!photos) return;
    if (!this._pendingEvent && !notes.length && !photos.length) return;
    if (this._pendingEvent) await this._finishDocumentation(notes, photos);
    else {
      await createTaskUpdate(this._task.taskId, {
        type: "note_photo_update",
        notes,
        photoKeys: photos,
      });
      this._mode = "timeline";
      await this._load();
      this.dispatchEvent(new CustomEvent("taskupdated", { bubbles: true }));
    }
  }

  async _finishDocumentation(notes, photos) {
    await documentTaskUpdate(this._task.taskId, this._pendingEvent.updateId, {
      notes,
      photoKeys: photos,
    });
    this._pendingEvent = null;
    this._noteDrafts = ["", "", ""];
    this._mode = "timeline";
    await this._load();
  }

  async _recordActionOutcome(root, type) {
    const text = this._actionText.trim();
    if (!text) return;
    const buttons = root.querySelectorAll("[data-action-outcome]");
    buttons.forEach((button) => {
      button.disabled = true;
    });
    try {
      const response = await createTaskUpdate(this._task.taskId, {
        type,
        text,
      });
      this._pendingEvent = response.update;
      this._task = response.task;
      this._mode = "action-photos";
      this._resetFiles();
      this._render();
      this.dispatchEvent(new CustomEvent("taskupdated", { bubbles: true }));
    } catch {
      const error = root.querySelector(".task-update__error");
      if (error) {
        error.hidden = false;
        error.textContent = "Could not record the action. Please try again.";
      }
      buttons.forEach((button) => {
        button.disabled = false;
      });
    }
  }

  async _saveAction(root, skipPhotos = false) {
    const photos = skipPhotos ? [] : await this._uploadFiles(root);
    if (!photos) return;
    if (this._pendingEvent)
      await documentTaskUpdate(this._task.taskId, this._pendingEvent.updateId, {
        notes: [],
        photoKeys: photos,
      });
    else
      await createTaskUpdate(this._task.taskId, {
        type: "additional_action",
        text: this._actionText.trim(),
        photoKeys: photos,
      });
    this._pendingEvent = null;
    this._actionText = "";
    this._mode = "timeline";
    await this._load();
    this.dispatchEvent(new CustomEvent("taskupdated", { bubbles: true }));
  }

  _hasUnsavedDraft() {
    const hasPhotos = this._files.length > 0;
    const hasNotes = this._noteDrafts.some((note) => note.trim());
    if (["notes", "document", "note-text"].includes(this._mode))
      return hasPhotos || hasNotes;
    if (this._mode === "action") return Boolean(this._actionText.trim());
    if (this._mode === "action-photos") return hasPhotos;
    return false;
  }

  _showDiscardConfirmation() {
    const dialog = this.querySelector("[data-discard-dialog]");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async _close(discardConfirmed = false) {
    if (!discardConfirmed && this._hasUnsavedDraft()) {
      this._showDiscardConfirmation();
      return;
    }
    if (this._mode !== "timeline") {
      if (this._pendingEvent) {
        await documentTaskUpdate(
          this._task.taskId,
          this._pendingEvent.updateId,
          { notes: [], photoKeys: [] },
        ).catch(() => {});
        this._pendingEvent = null;
      }
      this._resetFiles();
      this._noteDrafts = ["", "", ""];
      this._noteIndex = 0;
      this._actionText = "";
      this._mode = "timeline";
      await this._load();
      return;
    }
    if (this._pendingEvent) {
      await documentTaskUpdate(this._task.taskId, this._pendingEvent.updateId, {
        notes: [],
        photoKeys: [],
      }).catch(() => {});
      this._pendingEvent = null;
    }
    this._open = false;
    this.querySelector("dialog")?.close();
    this.dispatchEvent(new CustomEvent("taskupdateclosed", { bubbles: true }));
  }
}

customElements.define("task-update-dialog", TaskUpdateDialog);
