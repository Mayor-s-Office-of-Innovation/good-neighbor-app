import { captureControls } from "./capture-controls.templates.js";
import { PHOTO_ACCEPT } from "../domain/attachment-files.js";
import { artifactPhoto } from "./artifact-photo.templates.js";
import {
  cityHelpQuestion,
  taskUpdateTextCard,
  taskUpdateActions,
  taskUpdateTimelineItem,
} from "./issue-updates.templates.js";
export { taskUpdateTimelineTone } from "./issue-updates.templates.js";
import { localizedAnalyzerText } from "../i18n/analyzer.js";
import { statusTickerMarkup } from "./status-ticker.js";
import { taskMediaUrl, taskMediaArtifactId } from "../domain/task-media.js";
import { taskCardTitle } from "../domain/task-title.js";
import { displayTaskId, unresolvedExpiryAt } from "../domain/home-tasks.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { formatPacificDateTime } from "../domain/task-updates.js";
import { MAX_TASK_UPDATE_NOTES } from "../domain/task-update-draft.js";

/** Translate static copy and escape it for HTML text. @param {string} key */
function translatedText(key) {
  return escapeHtml(t(key));
}

/** @param {{ mode: string, state: string, content: string }} view */
export function taskUpdateDialogShell({ mode, state, content }) {
  const showBack = mode === "note-text" || mode === "action-photos";
  return html`<dialog class="task-update" aria-labelledby="task-update-title">
      <div class="task-update__sheet">
        <header class="task-update__header">
          ${showBack
            ? html`<button
                class="btn-icon wa-plain"
                data-back
                aria-label="${escapeAttr(t("common.back"))}"
              >
                <wa-icon name="chevron-left"></wa-icon>
              </button>`
            : "<span></span>"}
          <button
            class="btn-icon wa-plain"
            data-close
            aria-label="${escapeAttr(t("common.close"))}"
          >
            <wa-icon name="xmark"></wa-icon>
          </button>
        </header>
        <p role="status" data-save-status></p>
        <button type="button" class="btn-outline" data-cancel-save hidden>
          ${translatedText("common.cancel")}
        </button>
        ${state === "loading"
          ? html`<p role="status">${translatedText("taskUpdate.loading")}</p>`
          : state === "error"
            ? html`<p class="app-error app-error--panel" role="alert">
                  ${translatedText("taskUpdate.loadError")}
                </p>
                <button type="button" class="btn-outline" data-retry-timeline>
                  ${translatedText("common.retry")}</button
                >${content}`
            : content}
      </div>
    </dialog>
    <dialog
      class="task-update__discard-dialog"
      aria-labelledby="task-update-discard-title"
      data-discard-dialog
    >
      <div class="task-update__discard-card">
        <h2 id="task-update-discard-title">
          ${translatedText("taskUpdate.discard.title")}
        </h2>
        <div class="task-update__discard-actions">
          <button
            type="button"
            class="task-update__discard-confirm"
            data-confirm-discard
          >
            ${translatedText("common.discardChanges")}
          </button>
          <button type="button" class="btn-outline" data-continue-editing>
            ${translatedText("taskUpdate.discard.cancel")}
          </button>
        </div>
      </div>
    </dialog>`;
}

/** @param {{ task: Record<string, any>, updates: Record<string, any>[], issueOrigin: string, originalMediaUrl: string, originalFullMediaUrl?: string, mediaUrls: Map<string, string | {downloadUrl: string, thumbnailUrl?: string}>, nextToken?: string | null, readOnly?: boolean, now?: Date }} view */
export function taskUpdateTimeline({
  task,
  updates,
  issueOrigin,
  originalMediaUrl,
  originalFullMediaUrl = "",
  mediaUrls,
  nextToken,
  now = new Date(),
  readOnly,
}) {
  const address =
    task.georeferencedAddress || task.siteAddress || task.address || "";
  const expected = task.responseExpectedAt
    ? new Date(task.responseExpectedAt)
    : null;
  const overdue =
    task.ticketStatus !== "Closed" &&
    expected &&
    expected.getTime() < now.getTime();
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
        "issue_resolved",
        "additional_action_resolved",
        "311_ticket_filed",
      ].includes(update.type),
    )
      ? [
          {
            type: "task_completed",
            label: "Site marked as resolved",
            occurredAt: task.completedAt,
          },
        ]
      : [];
  const isCall = task.kind === "non_actionable_escalation";
  const showAgencyMetadata =
    task.kind === "escalation" || isCall || Boolean(task.notifiedAt);
  const expiresAt = unresolvedExpiryAt(task, now);
  const archiveEvent =
    expiresAt && !updates.some((update) => update.type === "issue_expired")
      ? [
          {
            type: "issue_expired",
            label: t("taskUpdate.expired"),
            occurredAt: expiresAt,
          },
        ]
      : [];
  const timeline = [
    ...archiveEvent,
    ...updates,
    ...legacyCompletion,
    ...(nextToken ? [] : [creation]),
  ]
    .filter(
      (update) =>
        update.occurredAt ||
        (update.type === "city_status" &&
          "kind" in update &&
          update.kind === "resolved"),
    )
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
  const canonicalTitle =
    task.userFriendlyLabel || task.user_friendly_label || "";
  const analyzerTitle =
    canonicalTitle &&
    localizedAnalyzerText(task, canonicalTitle, "user_friendly_label");
  const title =
    analyzerTitle ||
    rulebookText(task.category) ||
    t("taskUpdate.fallbackTitle");
  return html`<section class="task-update__summary">
      ${statusTickerMarkup(task, { now: now.getTime() })}
      <p class="task-update__location">
        ${escapeHtml(String(address).split(/\r?\n|,/)[0])}
      </p>
      <h2 id="task-update-title">${escapeHtml(title)}</h2>
      <p class="task-update__description">
        ${escapeHtml(task.description || "")}
      </p>
      ${originalMediaUrl || task.evidence?.kind === "photo"
        ? html`<button
            class="task-update__photo-trigger"
            type="button"
            data-photo-lightbox
            disabled
            data-timeline-focus="original-photo"
            data-full-src="${escapeAttr(
              originalFullMediaUrl || originalMediaUrl,
            )}"
            data-photo-address="${escapeAttr(address)}"
            data-photo-time="${escapeAttr(
              task.createdAt || task.created_at || task.notifiedAt || "",
            )}"
          >
            ${artifactPhoto({
              className: "task-update__photo task-update__photo--original",
              src: originalMediaUrl,
              original: originalFullMediaUrl,
              checkId: task.checkId,
              artifactId: taskMediaArtifactId(task),
              alt: t("taskUpdate.photo.evidenceAlt", { title }),
            })}
          </button>`
        : ""}
      ${showAgencyMetadata
        ? html`<dl class="task-update__metadata">
            ${metadataRow(
              "taskUpdate.metadata.agency",
              rulebookText(task.agency, "rulebook.agency") ||
                t("taskUpdate.metadata.unknown"),
            )}
            ${metadataRow(
              "taskUpdate.metadata.notified",
              task.notifiedAt
                ? formatPacificDateTime(task.notifiedAt)
                : t("taskUpdate.metadata.unknown"),
            )}
            ${expected
              ? metadataRow(
                  "taskUpdate.metadata.responseExpected",
                  formatPacificDateTime(expected),
                )
              : ""}
          </dl>`
        : ""}
      ${overdue && !task.resolvedAt
        ? html`<p class="task-update__overdue">
            <strong>${translatedText("taskUpdate.overdue")}</strong>
          </p>`
        : ""}
    </section>
    <section class="task-update__section">
      <h3>${translatedText("taskUpdate.updates.title")}</h3>
      ${(task.canUpdate ?? task.status === "in_progress") && !readOnly
        ? taskUpdateActions()
        : ""}
    </section>
    <ol class="ticket-timeline task-update__timeline">
      ${timeline
        .map((update) => taskUpdateTimelineItem(update, task, mediaUrls, title))
        .join("")}
    </ol>
    ${nextToken
      ? html`<button type="button" class="btn-outline" data-load-older>
          ${translatedText("taskUpdate.updates.loadOlder")}
        </button>`
      : ""}
    <p>#${escapeHtml(task.shortId || task.taskId || "")}</p>`;
}

/** @param {{ pendingEvent: Record<string, any> | null, cityHelpNeeded?: boolean | null, results?: boolean, task?: Record<string, any> | null, photosAllowed?: boolean, files: File[], notes: string[], previews: string[] }} view */
export function taskUpdateCapture({
  pendingEvent,
  results = false,
  task = null,
  photosAllowed = true,
  files,
  notes,
  previews,
  cityHelpNeeded,
}) {
  const title = results
    ? t("taskUpdate.capture.resultsTitle")
    : pendingEvent?.type === "presence_resolved"
      ? t("taskUpdate.capture.successTitle")
      : pendingEvent
        ? t("taskUpdate.capture.pendingTitle")
        : t("taskUpdate.capture.title");
  const populatedNotes = notes.filter((note) => note.trim());
  const hasContent = files.length || populatedNotes.length;
  const ordinaryUpdate = !results && !pendingEvent;
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">${escapeHtml(title)}</h2>
    ${results && task ? captureTaskIdentity(task) : ""}
    ${results && !pendingEvent
      ? html`<p class="app-error app-error--panel" role="alert">
          ${translatedText("taskUpdate.capture.unattached")}
        </p>`
      : ""}
    ${!photosAllowed
      ? html`<p>${translatedText("taskUpdate.photo.unavailable")}</p>`
      : ""}
    ${ordinaryUpdate
      ? captureControls({
          photosAllowed,
          textKey: "taskUpdate.capture.typeNote",
          showText: populatedNotes.length < MAX_TASK_UPDATE_NOTES,
        })
      : ""}
    ${ordinaryUpdate && photosAllowed
      ? html`<input
            type="file"
            data-update-camera
            class="capture-picker"
            accept="${PHOTO_ACCEPT}"
            capture="environment"
            hidden
          /><input
            type="file"
            data-update-gallery
            class="capture-picker"
            accept="${PHOTO_ACCEPT}"
            multiple
            hidden
          />`
      : ""}
    ${!ordinaryUpdate
      ? html`
          <div class="task-update__capture-controls">
            ${photosAllowed
              ? html`<button
                    type="button"
                    class="btn-blue task-update__take-photo"
                    data-take-photo
                  >
                    <wa-icon name="camera" aria-hidden="true"></wa-icon
                    >${translatedText("taskUpdate.capture.takePhoto")}
                  </button>
                  <input
                    hidden
                    type="file"
                    accept="${PHOTO_ACCEPT}"
                    capture="environment"
                    multiple
                    aria-label="${escapeAttr(
                      t("taskUpdate.capture.takePhoto"),
                    )}"
                    data-photos
                  />`
              : ""}
            <div class="task-update__capture-secondary">
              ${populatedNotes.length < MAX_TASK_UPDATE_NOTES
                ? html`<button type="button" class="btn-outline" data-add-note>
                    <wa-icon name="keyboard" aria-hidden="true"></wa-icon
                    >${translatedText("taskUpdate.capture.typeNote")}
                  </button>`
                : ""}
              ${photosAllowed
                ? html`<button
                      type="button"
                      class="btn-outline"
                      data-upload-photos
                    >
                      <wa-icon name="image" aria-hidden="true"></wa-icon
                      >${translatedText("taskUpdate.capture.uploadPhotos")}
                    </button>
                    <input
                      hidden
                      type="file"
                      accept="${PHOTO_ACCEPT}"
                      multiple
                      aria-label="${escapeAttr(
                        t("taskUpdate.capture.uploadPhotos"),
                      )}"
                      data-upload-input
                    />`
                : ""}
            </div>
          </div>
        `
      : ""}
    <span hidden data-photo-upload-status role="status"
      ><wa-spinner></wa-spinner>${translatedText(
        "taskUpdate.capture.uploading",
      )}</span
    >
    <p hidden data-photo-error role="alert" class="task-update__error"></p>
    ${previews.length
      ? photoPicker(previews, "update", files, photosAllowed, false)
      : ""}
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
    ${cityHelpQuestion(cityHelpNeeded, !hasContent)}
    <div class="task-update__actions task-update__actions--footer">
      <button
        type="button"
        class="btn-ink"
        data-save-notes
        ${cityHelpNeeded === null ||
        (results && (!hasContent || !pendingEvent)) ||
        (!pendingEvent && !hasContent)
          ? "disabled"
          : ""}
      >
        ${translatedText("common.done")}
      </button>
      ${pendingEvent || results
        ? html`<button type="button" class="btn-outline" data-skip>
            ${translatedText("taskUpdate.skip")}
          </button>`
        : ""}
    </div>
  </section>`;
}

/**
 * Which card the results prompt belongs to: the same title and thumbnail
 * the list shows, so a prompt that lands while the user has moved on still
 * reads as that card's.
 * @param {Record<string, any>} task
 */
function captureTaskIdentity(task) {
  const mediaUrl = taskMediaUrl(task);
  const reference = displayTaskId(task);
  return html`<p class="task-update__capture-task">
    ${mediaUrl
      ? artifactPhoto({
          className: "task-update__capture-thumb",
          src: mediaUrl,
          original: task.mediaUrl,
          checkId: task.checkId,
          artifactId: taskMediaArtifactId(task),
        })
      : ""}
    <span class="task-update__capture-task-text"
      ><strong>${escapeHtml(taskCardTitle(task))}</strong>
      <span class="task-update__capture-ref"
        >#${escapeHtml(reference)}</span
      ></span
    >
  </p>`;
}

/** @param {string[]} previews @param {"update" | "action"} kind @param {File[]} [files] @param {boolean} [allowed] @param {boolean} [showPicker] */
function photoPicker(
  previews,
  kind,
  files = [],
  allowed = true,
  showPicker = true,
) {
  if (!allowed)
    return html`<p>${translatedText("taskUpdate.photo.unavailable")}</p>`;
  return html`<div class="task-update__photo-grid">
    ${showPicker
      ? html`<label class="photo-capture-tile task-update__photo-picker"
          ><input
            class="visually-hidden"
            type="file"
            accept="${PHOTO_ACCEPT}"
            capture="environment"
            multiple
            data-photos
          /><span
            class="photo-capture-tile__icon task-update__camera"
            aria-hidden="true"
            ><wa-icon name="camera"></wa-icon></span
          ><span class="photo-capture-tile__label"
            >${translatedText("check.photo.take")}</span
          ></label
        > `
      : ""}
    ${previews
      .map(
        (url, index) =>
          html`<div class="task-update__draft-photo">
            <button
              class="task-update__photo-trigger"
              type="button"
              data-photo-lightbox
              data-timeline-focus="original-photo"
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
            </button>
            <p hidden data-preview-unavailable role="status">
              ${translatedText("taskUpdate.photo.previewUnavailable")}
            </p>
            <button
              type="button"
              class="btn-outline task-update__remove-photo"
              data-remove-photo="${index}"
              aria-label="${escapeAttr(
                t("care.photo.remove", { index: index + 1 }),
              )}"
            >
              <wa-icon name="xmark" aria-hidden="true"></wa-icon>
            </button>
          </div>`,
      )
      .join("")}
    ${showPicker
      ? html`<p
          hidden
          data-photo-error
          role="alert"
          class="task-update__error"
        ></p>`
      : ""}
  </div>`;
}

/** @param {{ note: string }} view */
export function taskUpdateNoteEditor({ note }) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">${translatedText("taskUpdate.note.title")}</h2>
    ${taskUpdateTextCard(note, "note")}
    <button
      type="button"
      class="btn-ink task-update__next"
      data-save-note
      ${note.trim() ? "" : "disabled"}
    >
      ${translatedText("common.continue")}
    </button>
  </section>`;
}

/** @param {{ text: string, allowResolution?: boolean, cityHelpNeeded?: boolean | null }} view */
export function taskUpdateActionEditor({
  text,
  allowResolution = true,
  cityHelpNeeded,
}) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">${translatedText("taskUpdate.action.title")}</h2>
    <p class="task-update__subtitle">
      ${translatedText("taskUpdate.action.subtitle")}
    </p>
    ${taskUpdateTextCard(text, "action")}
    ${allowResolution
      ? html`<section class="task-update__outcome">
          <h3>${translatedText("taskUpdate.action.outcomeTitle")}</h3>
          <div class="task-update__actions">
            <button
              type="button"
              class="btn-theme wa-success wa-accent wa-pill"
              data-action-outcome="additional_action_resolved"
              ${text.trim() ? "" : "disabled"}
            >
              ${translatedText("taskUpdate.outcome.resolved")}
            </button>
            <button
              type="button"
              class="btn-theme wa-neutral wa-filled wa-pill"
              data-action-outcome="additional_action_still_present"
              ${text.trim() ? "" : "disabled"}
            >
              ${translatedText("taskUpdate.outcome.stillThere")}
            </button>
          </div>
        </section>`
      : html`${cityHelpQuestion(cityHelpNeeded, !text.trim())}<button
            type="button"
            class="btn-ink"
            data-save-action
            ${text.trim() && cityHelpNeeded !== null ? "" : "disabled"}
          >
            ${translatedText("common.done")}
          </button>`}
  </section>`;
}

/** @param {string[]} previews @param {File[]} [files] @param {boolean} [photosAllowed] */
export function taskUpdateActionPhotos(
  previews,
  files = [],
  photosAllowed = true,
) {
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">
      ${translatedText("taskUpdate.actionPhotos.title")}
    </h2>
    ${photoPicker(previews, "action", files, photosAllowed)}
    <div class="task-update__actions task-update__actions--footer">
      <button
        type="button"
        class="btn-ink"
        data-save-action
        ${previews.length ? "" : "disabled"}
      >
        ${translatedText("common.done")}</button
      ><button type="button" class="btn-outline" data-skip-action>
        ${translatedText("taskUpdate.skip")}
      </button>
    </div>
  </section>`;
}

/** @param {string} labelKey @param {string} value */
function metadataRow(labelKey, value) {
  return html`<div>
    <dt>${translatedText(labelKey)}</dt>
    <dd>${escapeHtml(value)}</dd>
  </div>`;
}
