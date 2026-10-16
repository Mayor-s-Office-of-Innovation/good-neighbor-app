import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "./task-details-dialog.css";
import { openOverlayDialog } from "../dialog-history.js";
import { taskMediaUrl } from "../domain/task-media.js";
import { formatMonthDayTime } from "../i18n/dates.js";
import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import {
  getTaskDetails,
  recordCustomTaskAction,
  separateDuplicate,
  updateTaskAction,
} from "../services/api.js";
import { hydrateTaskEvidence } from "../services/task-evidence.js";

const CUSTOM_ACTION = "__custom__";

/** @param {string} value */
function openAge(value) {
  const started = Date.parse(value);
  if (!Number.isFinite(started)) return "";
  const hours = Math.max(1, Math.floor((Date.now() - started) / 3_600_000));
  if (hours < 48) return t("taskDetails.openHours", { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 14) return t("taskDetails.openDays", { count: days });
  return t("taskDetails.openWeeks", { count: Math.floor(days / 7) });
}

/** @param {Record<string, any>} task */
function location(task) {
  return (
    task?.evidence?.georeferencedAddress ||
    task?.georeferencedAddress ||
    task?.siteAddress ||
    task?.address ||
    task?.placeName ||
    t("card.place.fallback")
  );
}

/** @param {Record<string, any>} member */
function memberRow(member) {
  const image = taskMediaUrl(member);
  const title = member.userFriendlyLabel || rulebookText(member.category) || "";
  return html`<li
    class="task-details__member"
    data-member-id="${escapeAttr(member.taskId)}"
  >
    ${image
      ? html`<img
          class="task-details__thumbnail"
          src="${escapeAttr(image)}"
          alt="${escapeAttr(title)}"
        />`
      : html`<span class="task-details__thumbnail task-details__placeholder"
          ><wa-icon name="image" aria-hidden="true"></wa-icon
        ></span>`}
    <div class="task-details__member-copy">
      <strong>${escapeHtml(formatMonthDayTime(member.createdAt))}</strong>
      <span>${escapeHtml(member.description || title)}</span>
      ${member.isDuplicate
        ? html`<button
            type="button"
            class="btn-outline btn-outline--sm task-details__separate"
            data-separate-id="${escapeAttr(member.taskId)}"
          >
            ${escapeHtml(t("taskDetails.separate"))}
          </button>`
        : ""}
    </div>
  </li>`;
}

export class TaskDetailsDialog extends HTMLElement {
  constructor() {
    super();
    this._details = null;
    this._clicked = null;
    this._problem = null;
    this._trigger = null;
    this._customDraft = "";
    this._selected = "";
    this._busy = false;
    this._changed = false;
    this._error = "";
    this._onChanged = () => {};
  }

  /** @param {Record<string,any>} task @param {Record<string,any>} problem @param {HTMLElement} trigger @param {()=>void} onChanged */
  async open(task, problem, trigger, onChanged) {
    this._clicked = task;
    this._problem = problem;
    this._trigger = trigger;
    this._onChanged = onChanged;
    this._render(true);
    openOverlayDialog(
      this.querySelector("dialog"),
      `task-details-${task.taskId}`,
    );
    try {
      const details = await getTaskDetails(task.taskId);
      details.members = await hydrateTaskEvidence(details.members || []);
      const hydratedClicked = details.members.find(
        (member) => member.taskId === task.taskId,
      );
      this._clicked = { ...task, ...(hydratedClicked || details.clicked) };
      this._details = details;
      this._selected = details.selectedRuleId || "";
      this._render();
    } catch (error) {
      console.error("load task details failed", error);
      this._error = t("taskDetails.loadError");
      this._render();
    }
  }

  _render(loading = false) {
    const clicked = this._clicked || {};
    const title = this._problem?.title || clicked.userFriendlyLabel || "";
    const members = this._details?.members || [];
    const actions = this._details?.actions || [];
    const custom = this._selected === CUSTOM_ACTION;
    const content = html`<div class="task-details__close-row">
        <button
          type="button"
          class="btn-icon"
          data-close
          aria-label="${escapeAttr(t("common.close"))}"
        >
          <wa-icon name="xmark" aria-hidden="true"></wa-icon>
        </button>
      </div>
      <p class="task-details__eyebrow">
        <wa-icon name="pen" aria-hidden="true"></wa-icon>
        <span>${escapeHtml(t("taskDetails.editing"))}</span>
      </p>
      <header class="task-details__header">
        <h2 id="task-details-title">${escapeHtml(title)}</h2>
        <p>
          ${escapeHtml(
            t("taskDetails.location", { location: location(clicked) }),
          )}
        </p>
        <p>
          ${escapeHtml(
            t("taskDetails.open", { duration: openAge(clicked.createdAt) }),
          )}
        </p>
      </header>
      ${loading
        ? html`<div class="task-details__loading">
            <wa-spinner></wa-spinner
            ><span>${escapeHtml(t("common.loading"))}</span>
          </div>`
        : html`${members.length
              ? html`<ul class="task-details__members">
                  ${members.map(memberRow).join("")}
                </ul>`
              : ""}
            ${actions.length
              ? html`<wa-select
                  class="task-details__select"
                  label="${escapeAttr(t("taskDetails.action"))}"
                  value="${escapeAttr(this._selected)}"
                  ${this._busy ? "disabled" : ""}
                >
                  ${actions
                    .map(
                      (action) =>
                        html`<wa-option value="${escapeAttr(action.ruleId)}"
                          >${escapeHtml(rulebookText(action.label))}</wa-option
                        >`,
                    )
                    .join("")}
                  <wa-option value="${CUSTOM_ACTION}"
                    >${escapeHtml(t("taskDetails.other"))}</wa-option
                  >
                </wa-select>`
              : ""}
            ${custom
              ? html`<div class="task-details__custom">
                  <wa-textarea
                    label="${escapeAttr(t("taskDetails.addWhat"))}"
                    rows="3"
                    resize="none"
                    maxlength="1000"
                    value="${escapeAttr(this._customDraft)}"
                    ${this._busy ? "disabled" : ""}
                  ></wa-textarea>
                  <fieldset>
                    <legend>${escapeHtml(t("taskDetails.resolved"))}</legend>
                    <div>
                      <button
                        type="button"
                        class="btn-ink"
                        data-resolved="true"
                        ${!this._customDraft.trim() || this._busy
                          ? "disabled"
                          : ""}
                      >
                        ${escapeHtml(t("taskDetails.resolvedYes"))}
                      </button>
                      <button
                        type="button"
                        class="btn-outline"
                        data-resolved="false"
                        ${!this._customDraft.trim() || this._busy
                          ? "disabled"
                          : ""}
                      >
                        ${escapeHtml(t("taskDetails.resolvedNo"))}
                      </button>
                    </div>
                  </fieldset>
                </div>`
              : ""}
            <p
              class="task-details__error"
              role="alert"
              ${this._error ? "" : "hidden"}
            >
              ${escapeHtml(this._error)}
            </p>`} `;
    let dialog = this.querySelector("dialog");
    if (!dialog) {
      this.innerHTML = html`<dialog
        class="task-details"
        aria-labelledby="task-details-title"
      >
        <section class="task-details__sheet"></section>
      </dialog>`;
      dialog = this.querySelector("dialog");
      dialog?.addEventListener("close", () => {
        if (this._changed) this._onChanged();
        if (this._trigger?.isConnected) this._trigger.focus();
        this.remove();
      });
      dialog?.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
    const sheet = dialog?.querySelector(".task-details__sheet");
    if (sheet) sheet.innerHTML = content;
    this.querySelector("[data-close]")?.addEventListener("click", () =>
      dialog?.close(),
    );
    const select = this.querySelector("wa-select");
    select?.addEventListener("change", () => this._selectAction(select.value));
    const textarea = this.querySelector("wa-textarea");
    textarea?.addEventListener("input", () => {
      this._customDraft = textarea.value;
      this.querySelectorAll("[data-resolved]").forEach((button) => {
        if (button instanceof HTMLButtonElement) {
          button.disabled = !this._customDraft.trim();
        }
      });
    });
    this.querySelectorAll("[data-resolved]").forEach((button) => {
      if (!(button instanceof HTMLElement)) return;
      button.addEventListener("click", () =>
        this._recordCustom(button.dataset.resolved === "true"),
      );
    });
    this.querySelectorAll("[data-separate-id]").forEach((button) => {
      if (!(button instanceof HTMLElement)) return;
      button.addEventListener("click", () =>
        this._separate(button.dataset.separateId),
      );
    });
  }

  async _selectAction(value) {
    this._selected = String(value);
    this._error = "";
    if (this._selected === CUSTOM_ACTION) {
      this._render();
      return;
    }
    this._busy = true;
    this._render();
    try {
      const result = await updateTaskAction(
        this._clicked.taskId,
        this._selected,
      );
      this._changed = true;
      if (this._details) this._details.selectedRuleId = this._selected;
      this._clicked =
        this._clicked.taskId === result.task.taskId
          ? { ...this._clicked, ...result.task }
          : this._clicked;
    } catch (error) {
      console.error("update task action failed", error);
      this._error = t("taskDetails.saveError");
      this._selected = this._details?.selectedRuleId || "";
    } finally {
      this._busy = false;
      this._render();
    }
  }

  async _recordCustom(resolved) {
    if (!this._customDraft.trim() || this._busy) return;
    this._busy = true;
    this._error = "";
    this._render();
    try {
      await recordCustomTaskAction(this._clicked.taskId, {
        text: this._customDraft.trim(),
        resolved,
      });
      this._changed = true;
      this.querySelector("dialog")?.close();
    } catch (error) {
      console.error("record custom task action failed", error);
      this._busy = false;
      this._error = t("taskDetails.saveError");
      this._render();
    }
  }

  async _separate(taskId) {
    if (this._busy || !this._details) return;
    const member = this._details.members.find((item) => item.taskId === taskId);
    if (!member?.isDuplicate) return;
    this._busy = true;
    this._error = "";
    this._render();
    try {
      const result = await separateDuplicate(taskId, {
        sourceRevision: member.sourceRevision,
        originalTaskId: this._details.rootTaskId,
      });
      this._onChanged();
      if (taskId === this._clicked.taskId) {
        const details = await getTaskDetails(result.taskId);
        details.members = await hydrateTaskEvidence(details.members || []);
        this._details = details;
        this._clicked = {
          ...this._clicked,
          ...(details.members[0] || result.task),
        };
        this._selected = details.selectedRuleId || "";
      } else {
        this._details.members = this._details.members.filter(
          (item) => item.taskId !== taskId,
        );
      }
    } catch (error) {
      console.error("separate duplicate failed", error);
      this._error = t("duplicate.separateError");
    } finally {
      this._busy = false;
      this._render();
    }
  }
}

customElements.define("task-details-dialog", TaskDetailsDialog);

/** @param {Record<string,any>} task @param {Record<string,any>} problem @param {HTMLElement} trigger @param {()=>void} onChanged */
export function openTaskDetails(task, problem, trigger, onChanged) {
  const host = new TaskDetailsDialog();
  document.body.append(host);
  void host.open(task, problem, trigger, onChanged);
}
