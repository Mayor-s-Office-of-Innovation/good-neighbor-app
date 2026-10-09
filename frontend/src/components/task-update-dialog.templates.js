import {
  cityHelpQuestion,
  taskUpdateTextCard,
  taskUpdateActions,
  taskUpdateTimelineItem,
} from "./issue-updates.templates.js";
export { taskUpdateTimelineTone } from "./issue-updates.templates.js";
import { localizedAnalyzerText } from "../i18n/analyzer.js";
import { taskRoute } from "../domain/task-route.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { formatPacificDateTime } from "../domain/task-updates.js";
import { MAX_TASK_UPDATE_NOTES } from "../domain/task-update-draft.js";

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
  const address =
    task.georeferencedAddress || task.siteAddress || task.address || "";
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
        ${escapeHtml(String(address).split(/\r?\n|,/)[0])}
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
            data-photo-address="${escapeAttr(address)}"
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
        </section>`
      : ""}
    ${task.status === "in_progress"
      ? html`<section class="task-update__section">
          <h3>${escapeHtml(t("taskUpdate.updates.title"))}</h3>
          ${taskUpdateActions(task.presencePromptDue)}
        </section>`
      : html`<h3 class="task-update__updates-title">
          ${escapeHtml(t("taskUpdate.updates.title"))}
        </h3>`}
    <ol class="ticket-timeline task-update__timeline">
      ${timeline
        .map((update) => taskUpdateTimelineItem(update, task, mediaUrls, title))
        .join("")}
    </ol>
    ${nextToken
      ? html`<button type="button" class="btn-outline" data-load-older>
          ${escapeHtml(t("taskUpdate.updates.loadOlder"))}
        </button>`
      : ""}
    <p>#${escapeHtml(task.shortId || task.taskId || "")}</p>`;
}

/** @param {{ pendingEvent: Record<string, any> | null, cityHelpNeeded?: boolean | null, results?: boolean, photosAllowed?: boolean, files: File[], notes: string[], previews: string[] }} view */
export function taskUpdateCapture({
  pendingEvent,
  results = false,
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
  return html`<section class="task-update__capture">
    <h2 id="task-update-title">${escapeHtml(title)}</h2>
    ${results && !pendingEvent
      ? html`<p role="alert">
          ${escapeHtml(t("taskUpdate.capture.conflict"))}
        </p>`
      : ""}
    ${photoPicker(previews, "update", files, photosAllowed)}
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
    ${cityHelpQuestion(cityHelpNeeded, !hasContent)}
    <div class="task-update__actions task-update__actions--footer">
      <button
        type="button"
        class="btn-ink"
        data-save-notes
        ${cityHelpNeeded === null || (!pendingEvent && (results || !hasContent))
          ? "disabled"
          : ""}
      >
        ${escapeHtml(t("common.done"))}
      </button>
      ${pendingEvent || results
        ? html`<button type="button" class="btn-outline" data-skip>
            ${escapeHtml(t("taskUpdate.skip"))}
          </button>`
        : ""}
    </div>
  </section>`;
}

/** @param {string[]} previews @param {"update" | "action"} kind @param {File[]} [files] @param {boolean} [allowed] */
function photoPicker(previews, kind, files = [], allowed = true) {
  if (!allowed)
    return html`<p>${escapeHtml(t("taskUpdate.photo.unavailable"))}</p>`;
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
    ${taskUpdateTextCard(note, "note")}
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

/** @param {{ text: string, allowResolution?: boolean, cityHelpNeeded?: boolean | null }} view */
export function taskUpdateActionEditor({
  text,
  allowResolution = true,
  cityHelpNeeded,
}) {
  return html`<section class="task-update__capture task-update__capture--text">
    <h2 id="task-update-title">${escapeHtml(t("taskUpdate.action.title"))}</h2>
    <p class="task-update__subtitle">
      ${escapeHtml(t("taskUpdate.action.subtitle"))}
    </p>
    ${taskUpdateTextCard(text, "action")}
    ${allowResolution
      ? html`<section class="task-update__outcome">
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
        </section>`
      : html`${cityHelpQuestion(cityHelpNeeded, !text.trim())}<button
            type="button"
            class="btn-ink"
            data-save-action
            ${text.trim() && cityHelpNeeded !== null ? "" : "disabled"}
          >
            ${escapeHtml(t("common.done"))}
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
      ${escapeHtml(t("taskUpdate.actionPhotos.title"))}
    </h2>
    ${photoPicker(previews, "action", files, photosAllowed)}
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
