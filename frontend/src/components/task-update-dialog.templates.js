import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { formatPacificDateTime } from "../domain/task-updates.js";
import {
  MAX_TASK_UPDATE_NOTES,
  MAX_TASK_UPDATE_TEXT,
} from "../domain/task-update-draft.js";

/** @param {string} type */
export function taskUpdateTimelineTone(type) {
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

/** @param {{ mode: string, state: string, content: string }} view */
export function taskUpdateDialogShell({ mode, state, content }) {
  const showBack = mode === "note-text" || mode === "action-photos";
  return html`<dialog class="task-update" aria-labelledby="task-update-title">
      <div class="task-update__sheet">
        <header class="task-update__header">
          ${showBack
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
        ${state === "loading"
          ? html`<p role="status">Loading updates…</p>`
          : ""}
        ${state === "error"
          ? html`<p role="alert">
              We couldn't load this issue. Please try again.
            </p>`
          : ""}
        ${state === "ready" ? content : ""}
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
            Discard changes
          </button>
          <button type="button" class="btn-outline" data-continue-editing>
            Back to editing
          </button>
        </div>
      </div>
    </dialog>`;
}

/** @param {{ task: Record<string, any>, updates: Record<string, any>[], issueOrigin: string, originalMediaUrl: string, mediaUrls: Map<string, string>, nextToken?: string | null, now?: Date }} view */
export function taskUpdateTimeline({
  task,
  updates,
  issueOrigin,
  originalMediaUrl,
  mediaUrls,
  nextToken,
  now = new Date(),
}) {
  const expected = task.responseExpectedAt
    ? new Date(task.responseExpectedAt)
    : null;
  const overdue = expected && expected.getTime() < now.getTime();
  const latestUpdateLabel = String(task.latestUpdateLabel || "").trim();
  const timeline = [
    ...updates,
    {
      type: "issue_created",
      label:
        issueOrigin === "single-problem"
          ? "Issue added as a single issue"
          : "Issue added during a perimeter check",
      occurredAt: task.createdAt || task.created_at || task.notifiedAt,
    },
  ].filter((update) => update.occurredAt);
  const title = task.userFriendlyLabel || task.category || "Issue update";
  return html`<section class="task-update__summary">
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
            task.georeferencedAddress || task.siteAddress || task.address || "",
          ).split(/\r?\n|,/)[0],
        )}
      </p>
      <h2 id="task-update-title">${escapeHtml(title)}</h2>
      <p class="task-update__description">
        ${escapeHtml(task.description || "")}
      </p>
      ${originalMediaUrl
        ? html`<img
            class="task-update__photo task-update__photo--original"
            src="${escapeAttr(originalMediaUrl)}"
            alt="Evidence for ${escapeAttr(title)}"
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
      ${overdue && !task.resolvedAt
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
              Resolved
            </button>
            <button
              type="button"
              class="btn-theme wa-neutral wa-filled wa-pill"
              data-presence="presence_still_present"
            >
              Still there
            </button>
          </div>
          <p class="task-update__error" role="alert" hidden></p>
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
              Add a note or photo
            </button>
            <button
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
              class="ticket-timeline__item task-update__timeline-item task-update__timeline-item--${taskUpdateTimelineTone(
                update.type,
              )}"
            >
              <div class="ticket-timeline__content">
                <strong>${escapeHtml(update.label)}</strong
                ><time datetime="${escapeAttr(update.occurredAt)}"
                  >${escapeHtml(formatPacificDateTime(update.occurredAt))}</time
                >
                ${update.text ? html`<p>${escapeHtml(update.text)}</p>` : ""}
                ${(update.notes || [])
                  .map((note) => html`<p>${escapeHtml(note)}</p>`)
                  .join("")}
                ${(update.photoKeys || [])
                  .map((artifactId) =>
                    mediaUrls.get(artifactId)
                      ? html`<img
                          class="task-update__photo"
                          src="${escapeAttr(mediaUrls.get(artifactId))}"
                          alt="Update photo for ${escapeAttr(title)}"
                        />`
                      : "",
                  )
                  .join("")}
              </div>
            </li>`,
        )
        .join("")}
    </ol>
    ${nextToken
      ? html`<button type="button" class="btn-outline" data-load-older>
          Load older updates
        </button>`
      : ""}
    <p>#${escapeHtml(task.shortId || task.taskId || "")}</p>`;
}

/** @param {{ pendingEvent: Record<string, any> | null, files: File[], notes: string[], previews: string[] }} view */
export function taskUpdateCapture({ pendingEvent, files, notes, previews }) {
  const title =
    pendingEvent?.type === "presence_resolved"
      ? "Document your success"
      : pendingEvent
        ? "Update this issue with a photo"
        : "Add a photo or note to this issue";
  const populatedNotes = notes.filter((note) => note.trim());
  const hasContent = files.length || populatedNotes.length;
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">${escapeHtml(title)}</h2>
    ${photoPicker(previews, "update")}
    ${populatedNotes.length
      ? html`<ul class="task-update__note-list">
          ${notes
            .map((note, index) =>
              note.trim()
                ? html`<li>
                    <button type="button" data-edit-note="${index}">
                      ${escapeHtml(note)}
                    </button>
                  </li>`
                : "",
            )
            .join("")}
        </ul>`
      : ""}
    ${populatedNotes.length < MAX_TASK_UPDATE_NOTES
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
        ${!pendingEvent && !hasContent ? "disabled" : ""}
      >
        Done
      </button>
      ${pendingEvent
        ? html`<button type="button" class="btn-outline" data-skip>
            Skip
          </button>`
        : ""}
    </div>
  </section>`;
}

/** @param {string[]} previews @param {string} label */
function photoPicker(previews, label) {
  return html`<div class="task-update__photo-grid">
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
    >
    ${previews
      .map(
        (url, index) =>
          html`<img
            class="task-update__photo task-update__photo--draft"
            src="${escapeAttr(url)}"
            alt="Selected ${label} photo ${index + 1}"
          />`,
      )
      .join("")}
  </div>`;
}

/** @param {{ note: string }} view */
export function taskUpdateNoteEditor({ note }) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">Add a typed note</h2>
    <div class="task-update__text-card">
      <textarea
        class="task-update__text-field"
        maxlength="${MAX_TASK_UPDATE_TEXT}"
        data-note-text
        aria-label="Typed note"
      >
${escapeHtml(note)}</textarea
      ><button type="button" class="task-update__clear" data-clear-note>
        Clear all
      </button>
    </div>
    <button
      type="button"
      class="btn-ink task-update__next"
      data-save-note
      ${note.trim() ? "" : "disabled"}
    >
      Continue
    </button>
  </section>`;
}

/** @param {{ text: string }} view */
export function taskUpdateActionEditor({ text }) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">Share a follow up action</h2>
    <p class="task-update__subtitle">
      Describe what else you did to address this issue.
    </p>
    <div class="task-update__text-card">
      <textarea
        class="task-update__text-field"
        maxlength="${MAX_TASK_UPDATE_TEXT}"
        data-action-text
        aria-label="Follow up action"
      >
${escapeHtml(text)}</textarea
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
          ${text.trim() ? "" : "disabled"}
        >
          Resolved
        </button>
        <button
          type="button"
          class="btn-theme wa-neutral wa-filled wa-pill"
          data-action-outcome="additional_action_still_present"
          ${text.trim() ? "" : "disabled"}
        >
          Still there
        </button>
      </div>
    </section>
    <p class="task-update__error" role="alert" hidden></p>
  </section>`;
}

/** @param {string[]} previews */
export function taskUpdateActionPhotos(previews) {
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">Document your action</h2>
    ${photoPicker(previews, "action")}
    <p class="task-update__error" role="alert" hidden></p>
    <div class="task-update__actions task-update__actions--footer">
      <button
        type="button"
        class="btn-ink"
        data-save-action
        ${previews.length ? "" : "disabled"}
      >
        Done</button
      ><button type="button" class="btn-outline" data-skip-action>Skip</button>
    </div>
  </section>`;
}
