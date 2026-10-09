import { MAX_TASK_UPDATE_TEXT } from "../domain/task-update-draft.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { formatPacificDateTime } from "../domain/task-updates.js";

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

/** @param {boolean} [outline] */
export function taskUpdateActions(outline = false) {
  return html`<div class="task-update__actions">
    <button
      type="button"
      class="${outline ? "btn-outline btn-outline--sm" : "btn-ink btn-ink--sm"}"
      data-mode="notes"
    >
      ${escapeHtml(t("taskUpdate.updates.addNote"))}
    </button>
    <button
      type="button"
      class="${outline ? "btn-outline btn-outline--sm" : "btn-ink btn-ink--sm"}"
      data-mode="action"
    >
      ${escapeHtml(t("taskUpdate.updates.recordAction"))}
    </button>
  </div>`;
}

/** @param {Record<string, any>} update @param {Record<string, any>} task @param {Map<string, string>} mediaUrls @param {string} title */
export function taskUpdateTimelineItem(update, task, mediaUrls, title) {
  return html`<li
    class="ticket-timeline__item task-update__timeline-item task-update__timeline-item--${taskUpdateTimelineTone(
      update.type,
    )}"
  >
    <div class="ticket-timeline__content">
      <strong
        >${escapeHtml(rulebookText(update.label, "server.taskUpdate"))}</strong
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
  </li>`;
}

/**
 * Undefined omits the question for non-311 flows; null requires a choice.
 * @param {boolean | null | undefined} needed
 * @param {boolean} disabled
 */
export function cityHelpQuestion(needed, disabled = false) {
  if (needed === undefined) return "";
  return html`<section
    class="task-update__outcome task-update__city-help"
    aria-labelledby="city-help-title"
  >
    <h3 id="city-help-title">${escapeHtml(t("taskUpdate.cityHelp.title"))}</h3>
    <div class="task-update__actions">
      <button
        type="button"
        class="btn-ink"
        data-city-help="yes"
        aria-pressed="${needed === true}"
        ${disabled ? "disabled" : ""}
      >
        ${escapeHtml(t("taskUpdate.cityHelp.yes"))}
      </button>
      <button
        type="button"
        class="btn-outline"
        data-city-help="no"
        aria-pressed="${needed === false}"
        aria-describedby="city-help-note"
        ${disabled ? "disabled" : ""}
      >
        ${escapeHtml(t("taskUpdate.cityHelp.no"))}
      </button>
    </div>
    <p
      id="city-help-note"
      class="task-update__city-help-note"
      ${needed === false ? "" : "hidden"}
    >
      ${escapeHtml(t("taskUpdate.cityHelp.notice"))}
    </p>
  </section>`;
}

/** @param {string} text @param {"note" | "action"} kind */
export function taskUpdateTextCard(text, kind) {
  return html`<div class="task-update__text-card">
    <textarea
      class="task-update__text-field"
      maxlength="${MAX_TASK_UPDATE_TEXT}"
      data-${kind}-text
      aria-label="${escapeAttr(t(`taskUpdate.${kind}.aria`))}"
    >
${escapeHtml(text)}</textarea
    ><button
      type="button"
      class="task-update__clear"
      ${kind === "note" ? "data-clear-note" : "data-clear"}
    >
      ${escapeHtml(t("common.clearAll"))}
    </button>
  </div>`;
}
