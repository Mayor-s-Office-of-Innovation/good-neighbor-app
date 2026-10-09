import { taskRoute } from "../domain/task-route.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { analyzerTranslation } from "../i18n/analyzer-text.js";
import { rulebookText } from "../i18n/rulebook.js";
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
  if (
    type === "task_completed" ||
    type === "presence_resolved" ||
    type === "additional_action_resolved"
  )
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
                aria-label="${escapeAttr(t("common.back"))}"
              >
                <wa-icon name="chevron-left"></wa-icon>
              </button>`
            : html`<span></span>`}
          <button
            type="button"
            class="btn-icon wa-plain"
            data-close
            aria-label="${escapeAttr(t("common.close"))}"
          >
            <wa-icon name="xmark"></wa-icon>
          </button>
        </header>
        ${state === "loading"
          ? html`<p role="status">${escapeHtml(t("taskUpdate.loading"))}</p>`
          : ""}
        ${state === "error"
          ? html`<p role="alert">${escapeHtml(t("taskUpdate.loadError"))}</p>`
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
          ${escapeHtml(t("taskUpdate.discard.title"))}
        </h2>
        <div class="task-update__discard-actions">
          <button
            type="button"
            class="task-update__discard-confirm"
            data-confirm-discard
          >
            ${escapeHtml(t("common.discardChanges"))}
          </button>
          <button type="button" class="btn-outline" data-continue-editing>
            ${escapeHtml(t("taskUpdate.discard.cancel"))}
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
  const creation = /** @type {Record<string, any>} */ ({
    type: "issue_created",
    label:
      issueOrigin === "single-problem"
        ? t("taskUpdate.created.single")
        : t("taskUpdate.created.perimeter"),
    occurredAt: task.createdAt || task.created_at || task.notifiedAt,
  });
  // Older direct completions saved the timestamp but no timeline event.
  /** @type {Array<Record<string, any>>} */
  const legacyCompletion =
    !nextToken &&
    task.status === "completed" &&
    !task.inProgressAt &&
    task.completedAt &&
    !updates.some((update) =>
      [
        "task_completed",
        "presence_resolved",
        "additional_action_resolved",
        "311_ticket_filed",
      ].includes(update.type),
    )
      ? [
          {
            type: "task_completed",
            label: "Marked as complete",
            occurredAt: task.completedAt,
          },
        ]
      : [];
  const isCall = task.kind === "non_actionable_escalation";
  const route = taskRoute(task);
  const showAgencyMetadata =
    task.kind === "escalation" || isCall || Boolean(task.notifiedAt);
  const timeline = [
    ...updates,
    ...legacyCompletion,
    ...(nextToken ? [] : [creation]),
  ]
    .filter((update) => update.occurredAt)
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
  const englishTitle = task.userFriendlyLabel || task.user_friendly_label || "";
  const analyzerTitle = englishTitle
    ? (analyzerTranslation(task, "user_friendly_label") ?? englishTitle)
    : "";
  const title =
    analyzerTitle ||
    rulebookText(task.category) ||
    t("taskUpdate.fallbackTitle");
  return html`<section class="task-update__summary">
      <p class="task-update__route task-update__route--${route.tone}">
        <span class="task-update__route-label">${escapeHtml(route.label)}</span
        >${latestUpdateLabel
          ? html`<span class="task-update__route-separator" aria-hidden="true"
                >·</span
              >
              <strong
                >${escapeHtml(
                  rulebookText(latestUpdateLabel, "server.taskUpdate"),
                )}</strong
              >`
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
        ? html`<button
            class="task-update__photo-trigger"
            type="button"
            data-photo-lightbox
            data-photo-address="${escapeAttr(
              task.georeferencedAddress ||
                task.siteAddress ||
                task.address ||
                "",
            )}"
            data-photo-time="${escapeAttr(
              task.createdAt || task.created_at || task.notifiedAt || "",
            )}"
          >
            <img
              class="task-update__photo task-update__photo--original"
              src="${escapeAttr(originalMediaUrl)}"
              alt="${escapeAttr(t("taskUpdate.photo.evidenceAlt", { title }))}"
            />
          </button>`
        : ""}
      ${showAgencyMetadata
        ? html`<dl class="task-update__metadata">
            <div>
              <dt>${escapeHtml(t("taskUpdate.metadata.agency"))}</dt>
              <dd>
                ${escapeHtml(
                  rulebookText(task.agency, "rulebook.agency") ||
                    t("taskUpdate.metadata.unknown"),
                )}
              </dd>
            </div>
            <div>
              <dt>${escapeHtml(t("taskUpdate.metadata.notified"))}</dt>
              <dd>
                ${escapeHtml(
                  task.notifiedAt
                    ? formatPacificDateTime(task.notifiedAt)
                    : t("taskUpdate.metadata.unknown"),
                )}
              </dd>
            </div>
            ${expected
              ? html`<div>
                  <dt>
                    ${escapeHtml(t("taskUpdate.metadata.responseExpected"))}
                  </dt>
                  <dd>${escapeHtml(formatPacificDateTime(expected))}</dd>
                </div>`
              : ""}
          </dl>`
        : ""}
      ${overdue && !task.resolvedAt
        ? html`<p class="task-update__overdue">
            <strong>${escapeHtml(t("taskUpdate.overdue"))}</strong>
          </p>`
        : ""}
    </section>
    ${task.presencePromptDue
      ? html`<section class="task-update__prompt">
          <h3>${escapeHtml(t("taskUpdate.presence.title"))}</h3>
          <div class="task-update__actions">
            <button
              type="button"
              class="btn-theme wa-success wa-accent wa-pill"
              data-presence="presence_resolved"
            >
              ${escapeHtml(t("taskUpdate.outcome.resolved"))}
            </button>
            <button
              type="button"
              class="btn-theme wa-neutral wa-filled wa-pill"
              data-presence="presence_still_present"
            >
              ${escapeHtml(t("taskUpdate.outcome.stillThere"))}
            </button>
          </div>
          <p class="task-update__error" role="alert" hidden></p>
        </section>`
      : ""}
    ${task.status === "in_progress"
      ? html`<section class="task-update__section">
          <h3>${escapeHtml(t("taskUpdate.updates.title"))}</h3>
          <div class="task-update__actions">
            <button
              type="button"
              class="${task.presencePromptDue
                ? "btn-outline btn-outline--sm"
                : "btn-ink btn-ink--sm"}"
              data-mode="notes"
            >
              ${escapeHtml(t("taskUpdate.updates.addNote"))}
            </button>
            <button
              type="button"
              class="${task.presencePromptDue
                ? "btn-outline btn-outline--sm"
                : "btn-ink btn-ink--sm"}"
              data-mode="action"
            >
              ${escapeHtml(t("taskUpdate.updates.recordAction"))}
            </button>
          </div>
        </section>`
      : html`<h3 class="task-update__updates-title">
          ${escapeHtml(t("taskUpdate.updates.title"))}
        </h3>`}
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
                <strong
                  >${escapeHtml(
                    rulebookText(update.label, "server.taskUpdate"),
                  )}</strong
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
                      ? html`<button
                          class="task-update__photo-trigger"
                          type="button"
                          data-photo-lightbox
                          data-photo-address="${escapeAttr(
                            task.georeferencedAddress ||
                              task.siteAddress ||
                              task.address ||
                              "",
                          )}"
                          data-photo-time="${escapeAttr(update.occurredAt)}"
                        >
                          <img
                            class="task-update__photo"
                            src="${escapeAttr(mediaUrls.get(artifactId))}"
                            alt="${escapeAttr(
                              t("taskUpdate.photo.updateAlt", { title }),
                            )}"
                          />
                        </button>`
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
          ${escapeHtml(t("taskUpdate.updates.loadOlder"))}
        </button>`
      : ""}
    <p>#${escapeHtml(task.shortId || task.taskId || "")}</p>`;
}

/** @param {{ pendingEvent: Record<string, any> | null, files: File[], notes: string[], previews: string[] }} view */
export function taskUpdateCapture({ pendingEvent, files, notes, previews }) {
  const title =
    pendingEvent?.type === "presence_resolved"
      ? t("taskUpdate.capture.successTitle")
      : pendingEvent
        ? t("taskUpdate.capture.pendingTitle")
        : t("taskUpdate.capture.title");
  const populatedNotes = notes.filter((note) => note.trim());
  const hasContent = files.length || populatedNotes.length;
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">${escapeHtml(title)}</h2>
    ${photoPicker(previews, "update", files)}
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
          ${escapeHtml(t("taskUpdate.capture.addNote"))}
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
        ${escapeHtml(t("common.done"))}
      </button>
      ${pendingEvent
        ? html`<button type="button" class="btn-outline" data-skip>
            ${escapeHtml(t("taskUpdate.skip"))}
          </button>`
        : ""}
    </div>
  </section>`;
}

/** @param {string[]} previews @param {"update" | "action"} kind @param {File[]} [files] */
function photoPicker(previews, kind, files = []) {
  return html`<div class="task-update__photo-grid">
    <label class="photo-capture-tile task-update__photo-picker"
      ><input
        class="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        data-photos
      /><span
        class="photo-capture-tile__icon task-update__camera"
        aria-hidden="true"
        ><wa-icon name="camera"></wa-icon></span
      ><span class="photo-capture-tile__label"
        >${escapeHtml(t("check.photo.take"))}</span
      ></label
    >
    ${previews
      .map(
        (url, index) =>
          html`<button
            class="task-update__photo-trigger"
            type="button"
            data-photo-lightbox
            data-photo-time="${escapeAttr(
              files[index]?.lastModified
                ? new Date(files[index].lastModified).toISOString()
                : "",
            )}"
          >
            <img
              class="task-update__photo task-update__photo--draft"
              src="${escapeAttr(url)}"
              alt="${escapeAttr(
                t(
                  kind === "action"
                    ? "taskUpdate.photo.selectedActionAlt"
                    : "taskUpdate.photo.selectedUpdateAlt",
                  { index: index + 1 },
                ),
              )}"
            />
          </button>`,
      )
      .join("")}
  </div>`;
}

/** @param {{ note: string }} view */
export function taskUpdateNoteEditor({ note }) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">${escapeHtml(t("taskUpdate.note.title"))}</h2>
    <div class="task-update__text-card">
      <textarea
        class="task-update__text-field"
        maxlength="${MAX_TASK_UPDATE_TEXT}"
        data-note-text
        aria-label="${escapeAttr(t("taskUpdate.note.aria"))}"
      >
${escapeHtml(note)}</textarea
      ><button type="button" class="task-update__clear" data-clear-note>
        ${escapeHtml(t("common.clearAll"))}
      </button>
    </div>
    <button
      type="button"
      class="btn-ink task-update__next"
      data-save-note
      ${note.trim() ? "" : "disabled"}
    >
      ${escapeHtml(t("common.continue"))}
    </button>
  </section>`;
}

/** @param {{ text: string }} view */
export function taskUpdateActionEditor({ text }) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">${escapeHtml(t("taskUpdate.action.title"))}</h2>
    <p class="task-update__subtitle">
      ${escapeHtml(t("taskUpdate.action.subtitle"))}
    </p>
    <div class="task-update__text-card">
      <textarea
        class="task-update__text-field"
        maxlength="${MAX_TASK_UPDATE_TEXT}"
        data-action-text
        aria-label="${escapeAttr(t("taskUpdate.action.aria"))}"
      >
${escapeHtml(text)}</textarea
      ><button type="button" class="task-update__clear" data-clear>
        ${escapeHtml(t("common.clearAll"))}
      </button>
    </div>
    <section class="task-update__outcome">
      <h3>${escapeHtml(t("taskUpdate.action.outcomeTitle"))}</h3>
      <div class="task-update__actions">
        <button
          type="button"
          class="btn-theme wa-success wa-accent wa-pill"
          data-action-outcome="additional_action_resolved"
          ${text.trim() ? "" : "disabled"}
        >
          ${escapeHtml(t("taskUpdate.outcome.resolved"))}
        </button>
        <button
          type="button"
          class="btn-theme wa-neutral wa-filled wa-pill"
          data-action-outcome="additional_action_still_present"
          ${text.trim() ? "" : "disabled"}
        >
          ${escapeHtml(t("taskUpdate.outcome.stillThere"))}
        </button>
      </div>
    </section>
    <p class="task-update__error" role="alert" hidden></p>
  </section>`;
}

/** @param {string[]} previews @param {File[]} [files] */
export function taskUpdateActionPhotos(previews, files = []) {
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">
      ${escapeHtml(t("taskUpdate.actionPhotos.title"))}
    </h2>
    ${photoPicker(previews, "action", files)}
    <p class="task-update__error" role="alert" hidden></p>
    <div class="task-update__actions task-update__actions--footer">
      <button
        type="button"
        class="btn-ink"
        data-save-action
        ${previews.length ? "" : "disabled"}
      >
        ${escapeHtml(t("common.done"))}</button
      ><button type="button" class="btn-outline" data-skip-action>
        ${escapeHtml(t("taskUpdate.skip"))}
      </button>
    </div>
  </section>`;
}
