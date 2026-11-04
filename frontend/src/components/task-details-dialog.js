import { artifactPhoto } from "./artifact-photo.templates.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "./task-details-dialog.css";
import "@awesome.me/webawesome/dist/components/textarea/textarea.js";
import { onBackdropDismiss, awaitOverlayUnwind } from "../dialog-history.js";
import { showToast } from "../state/toasts.js";
import {
  saveCardDescription,
  syncCardDetails,
} from "../services/card-description.js";
import { openOverlayDialog } from "../dialog-history.js";
import { taskMediaUrl, taskMediaArtifactId } from "../domain/task-media.js";
import { formatMonthDayTime } from "../i18n/dates.js";
import { t } from "../i18n/i18n.js";
import { rulebookText } from "../i18n/rulebook.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import {
  getTaskDetails,
  getConditionDetails,
  editAnalysisCondition,
  recordCustomTaskAction,
  separateDuplicate,
  updateTaskAction,
} from "../services/api.js";
import { hydrateTaskEvidence } from "../services/task-evidence.js";

const CUSTOM_ACTION = "__custom__";

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
function memberRow(member, editingId, editingConditionId) {
  const isEditing = member.taskId
    ? member.taskId === editingId
    : Boolean(member.conditionId && member.conditionId === editingConditionId);
  const image = taskMediaUrl(member);
  const title = member.userFriendlyLabel || rulebookText(member.category) || "";
  return html`<li
    class="task-details__member"
    data-member-id="${escapeAttr(member.taskId || member.conditionId)}"
  >
    ${isEditing && !member.isDuplicate
      ? ""
      : html`<div class="task-details__member-copy">
          ${isEditing
            ? ""
            : html`<strong>${escapeHtml(location(member))}</strong>
                <time datetime="${escapeAttr(member.createdAt || "")}"
                  >${escapeHtml(formatMonthDayTime(member.createdAt))}</time
                >
                <span>${escapeHtml(member.description || title)}</span>`}
          ${member.isDuplicate
            ? html`<button
                type="button"
                class="btn-outline btn-outline--sm task-details__separate"
                data-separate-id="${escapeAttr(member.taskId)}"
              >
                ${escapeHtml(t("taskDetails.separate"))}
              </button>`
            : ""}
        </div>`}
    ${image || member.evidence?.kind === "photo"
      ? html`<button
          type="button"
          class="task-details__photo"
          data-photo-lightbox
          data-full-src="${escapeAttr(member.mediaUrl || image || "")}"
          data-photo-address="${escapeAttr(location(member))}"
          data-photo-time="${escapeAttr(member.createdAt || "")}"
          aria-label="${escapeAttr(t("lightbox.image.alt"))}"
        >
          ${artifactPhoto({
            className: "task-details__thumbnail",
            src: image,
            original: member.mediaUrl,
            checkId: member.checkId,
            artifactId: taskMediaArtifactId(member),
            alt: title,
          })}
        </button>`
      : html`<span
          class="task-details__thumbnail task-details__placeholder"
          role="img"
          aria-label="${escapeAttr(t("card.evidence.unavailable"))}"
          ><wa-icon name="image-slash" aria-hidden="true"></wa-icon
        ></span>`}
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
    this._description = "";
    this._title = "";
    this._category = "";
    this._resolved = null;
    this._busy = false;
    this._error = "";
    this._baseline = "";
    this._descriptionOnly = false;
    this._onChanged = () => {};
  }

  async open(task, problem, trigger, onChanged) {
    this._clicked = task;
    this._problem = problem;
    this._trigger = trigger;
    this._onChanged = onChanged;
    this._overlayId = `task-details-${task.taskId || problem.itemId || problem.conditionId}`;
    this._render(true);
    this._show();
    try {
      if (this._descriptionOnly && !problem.conditionId) {
        this._description = problem.description || "";
        this._title = problem.title || "";
      } else {
        const details = task.taskId
          ? await getTaskDetails(task.taskId)
          : await getConditionDetails(problem);
        if (details.editable === false) throw new Error("Work has begun");
        details.members = await hydrateTaskEvidence(details.members || []);
        this._descriptionOnly = !task.taskId;
        this._clicked = { ...task, ...(details.clicked || {}) };
        this._details = details;
        this._selected = details.selectedRuleId || "";
        this._category = details.category || this._clicked.category || "";
        this._originalCategory = this._category;
        this._title = this._clicked.userFriendlyLabel || problem.title || "";
        this._customDraft = details.customAction?.text || "";
        this._resolved = details.customAction?.resolved ?? null;
        this._description =
          this._clicked.description || problem.description || "";
      }
      this._originalDescription = this._description.trim();
      this._originalSelected = this._selected;
      this._baseline = this._draftKey();
      this._render();
    } catch (error) {
      console.error("load task details failed", error);
      this._error = t("taskDetails.loadError");
      this._render();
    }
  }

  _draftKey() {
    return JSON.stringify([
      this._description.trim(),
      this._title.trim(),
      this._category,
      this._selected,
      ...(this._selected === CUSTOM_ACTION
        ? [this._customDraft.trim(), this._resolved]
        : []),
    ]);
  }

  _dirty() {
    return Boolean(this._baseline && this._draftKey() !== this._baseline);
  }

  _valid() {
    const length = this._description.trim().length;
    return (
      this._dirty() &&
      length >= 5 &&
      length <= 4000 &&
      this._title.trim().length > 0 &&
      this._title.trim().length <= 160 &&
      ((!this._originalSelected && this._category === this._originalCategory) ||
        Boolean(this._selected) ||
        !this._details) &&
      (this._selected !== CUSTOM_ACTION ||
        (this._customDraft.trim().length > 0 &&
          this._customDraft.trim().length <= 1000 &&
          typeof this._resolved === "boolean"))
    );
  }

  _show() {
    if (!this.isConnected) document.body.append(this);
    openOverlayDialog(this.querySelector("dialog"), this._overlayId, () =>
      this._requestClose(),
    );
  }

  _requestClose() {
    if (!this._dirty()) {
      this.querySelector("dialog")?.close();
      return;
    }
    const confirmation = /** @type {HTMLDialogElement} */ (
      this.querySelector("dialog[data-discard-dialog]")
    );
    if (!confirmation.open) confirmation.showModal();
  }

  _syncSave() {
    const save = /** @type {HTMLButtonElement} */ (
      this.querySelector("button[data-save]")
    );
    if (save) save.disabled = !this._valid() || this._busy;
    /** @type {NodeListOf<HTMLButtonElement>} */ (
      this.querySelectorAll("button[data-separate-id]")
    ).forEach((button) => {
      button.disabled = this._dirty() || this._busy;
    });
  }

  _render(loading = false) {
    const clicked = this._clicked || {};
    const context =
      this._details?.members?.find((member) =>
        clicked.taskId
          ? member.taskId === clicked.taskId
          : member.conditionId === this._problem?.conditionId,
      ) || clicked;
    const title = this._problem?.title || clicked.userFriendlyLabel || "";
    const actions =
      this._details?.categories?.find(
        (option) => option.category === this._category,
      )?.actions ||
      this._details?.actions ||
      [];
    const files311 = actions.find(
      (action) => action.ruleId === this._selected,
    )?.files311;
    let dialog = this.querySelector("dialog");
    if (!dialog) {
      this.innerHTML = html`<dialog
          class="task-details"
          aria-labelledby="task-details-title"
        >
          <section class="task-details__sheet"></section>
        </dialog>
        <dialog
          class="task-details"
          data-discard-dialog
          aria-labelledby="task-discard-title"
        >
          <section class="task-details__sheet task-details__discard">
            <h2 id="task-discard-title">
              ${escapeHtml(t("details.discardTitle"))}
            </h2>
            <p>${escapeHtml(t("details.discardText"))}</p>
            <button class="btn-ink" data-continue autofocus>
              ${escapeHtml(t("details.continueEditing"))}
            </button>
            <button class="btn-danger" data-discard>
              ${escapeHtml(t("details.discardExit"))}
            </button>
          </section>
        </dialog>`;
      dialog = this.querySelector("dialog");
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        this._requestClose();
      });
      onBackdropDismiss(dialog, () => this._requestClose());
      dialog.addEventListener("close", () => {
        if (this._trigger?.isConnected) this._trigger.focus();
        this.remove();
      });
      const confirmation = /** @type {HTMLDialogElement} */ (
        this.querySelector("dialog[data-discard-dialog]")
      );
      this.querySelector("[data-continue]").addEventListener("click", () =>
        confirmation.close(),
      );
      this.querySelector("[data-discard]").addEventListener("click", () => {
        confirmation.close();
        dialog.close();
      });
    }
    dialog.querySelector(".task-details__sheet").innerHTML = html` <div
        class="task-details__close-row"
      >
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
        <wa-icon name="pen" aria-hidden="true"></wa-icon
        ><span>${escapeHtml(t("taskDetails.editing"))}</span>
      </p>
      <header class="task-details__header">
        <h2 id="task-details-title">
          ${this._baseline && this._details
            ? html`<span
                data-title
                contenteditable="plaintext-only"
                role="textbox"
                aria-label="${escapeAttr(t("details.title"))}"
                aria-multiline="false"
                tabindex="0"
                spellcheck="true"
                >${escapeHtml(this._title)}</span
              >`
            : escapeHtml(title)}
        </h2>
        <p data-location>${escapeHtml(location(context))}</p>
        ${context.createdAt
          ? html`<p data-observed-at>
              <time datetime="${escapeAttr(context.createdAt)}"
                >${escapeHtml(formatMonthDayTime(context.createdAt))}</time
              >
            </p>`
          : ""}
      </header>
      ${loading
        ? html`<div class="task-details__loading">
            <wa-spinner></wa-spinner>${escapeHtml(t("common.loading"))}
          </div>`
        : html` ${this._details?.members?.length
              ? html`<ul class="task-details__members">
                  ${this._details.members
                    .map((member) =>
                      memberRow(
                        member,
                        clicked.taskId,
                        this._problem?.conditionId,
                      ),
                    )
                    .join("")}
                </ul>`
              : ""}
            ${this._baseline
              ? html`${this._details
                    ? html` <wa-select
                        data-category
                        label="${escapeAttr(t("details.category"))}"
                        value="${escapeAttr(this._category)}"
                      >
                        ${(this._details.categories || [])
                          .map(
                            (option) =>
                              html`<wa-option
                                value="${escapeAttr(option.category)}"
                                >${escapeHtml(
                                  rulebookText(option.category),
                                )}</wa-option
                              >`,
                          )
                          .join("")}
                      </wa-select>`
                    : ""}<wa-textarea
                    data-description
                    label="${escapeAttr(
                      t("analysis.editDialog.descriptionLabel"),
                    )}"
                    hint="${escapeAttr(
                      t(
                        files311
                          ? "details.reportDescriptionHint"
                          : "details.descriptionHint",
                      ),
                    )}"
                    rows="5"
                    resize="vertical"
                    minlength="5"
                    maxlength="4000"
                    value="${escapeAttr(this._description)}"
                  ></wa-textarea>`
              : ""}
            ${actions.length
              ? html`<wa-select
                  class="task-details__select"
                  data-action-select
                  label="${escapeAttr(t("taskDetails.action"))}"
                  placeholder="${escapeAttr(t("details.selectAction"))}"
                  value="${escapeAttr(this._selected)}"
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
                  ></wa-select
                >`
              : ""}
            ${this._selected === CUSTOM_ACTION
              ? html`<div class="task-details__custom">
                  <wa-textarea
                    data-custom
                    label="${escapeAttr(t("taskDetails.addWhat"))}"
                    rows="3"
                    maxlength="1000"
                    value="${escapeAttr(this._customDraft)}"
                  ></wa-textarea>
                  <fieldset>
                    <legend>${escapeHtml(t("taskDetails.resolved"))}</legend>
                    <div>
                      ${[true, false]
                        .map(
                          (value) =>
                            html`<button
                              type="button"
                              class="${this._resolved === value
                                ? "btn-ink"
                                : "btn-outline"}"
                              aria-pressed="${this._resolved === value}"
                              data-resolved="${value}"
                            >
                              ${escapeHtml(
                                t(
                                  value
                                    ? "taskDetails.resolvedYes"
                                    : "taskDetails.resolvedNo",
                                ),
                              )}
                            </button>`,
                        )
                        .join("")}
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
            </p>
            ${this._baseline
              ? html`<button
                  type="button"
                  class="btn-ink task-details__save"
                  data-save
                  ${this._valid() ? "" : "disabled"}
                >
                  ${escapeHtml(t("common.save"))}
                </button>`
              : ""}`}`;
    this.querySelectorAll("[data-photo-lightbox]").forEach((trigger) => {
      trigger.addEventListener("click", (event) => {
        event.stopPropagation();
        void import("./photo-lightbox.js").then(({ openPhotoLightbox }) =>
          openPhotoLightbox(this, /** @type {HTMLElement} */ (trigger), dialog),
        );
      });
    });
    this.querySelector("[data-close]").addEventListener("click", () =>
      this._requestClose(),
    );
    const select = /** @type {HTMLElementTagNameMap["wa-select"]} */ (
      this.querySelector("wa-select[data-action-select]")
    );
    select?.addEventListener("change", async () => {
      this._selected = String(select.value || "");
      this._render();
      const next = /** @type {HTMLElementTagNameMap["wa-select"]} */ (
        this.querySelector("wa-select[data-action-select]")
      );
      await next?.updateComplete;
      if (next?.isConnected && dialog.open) next.focus();
    });
    const category = /** @type {HTMLElementTagNameMap["wa-select"]} */ (
      this.querySelector("wa-select[data-category]")
    );
    category?.addEventListener("change", async () => {
      if (this._category === category.value) return;
      this._category = String(category.value);
      this._selected = "";
      this._render();
      const next = /** @type {HTMLElementTagNameMap["wa-select"]} */ (
        this.querySelector("wa-select[data-action-select]")
      );
      await next?.updateComplete;
      if (next?.isConnected && dialog.open) next.focus();
    });
    const titleInput = /** @type {HTMLElement | null} */ (
      this.querySelector("[data-title]")
    );
    titleInput?.addEventListener("input", () => {
      this._title = titleInput.textContent || "";
      titleInput.setAttribute(
        "aria-invalid",
        String(!this._title.trim() || this._title.trim().length > 160),
      );
      this._syncSave();
    });
    titleInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    const description =
      /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default} */ (
        this.querySelector("wa-textarea[data-description]")
      );
    description?.addEventListener("input", () => {
      this._description = description.value;
      this._syncSave();
    });
    const custom =
      /** @type {import("@awesome.me/webawesome/dist/components/textarea/textarea.js").default} */ (
        this.querySelector("wa-textarea[data-custom]")
      );
    custom?.addEventListener("input", () => {
      this._customDraft = custom.value;
      this._syncSave();
    });
    /** @type {NodeListOf<HTMLButtonElement>} */ (
      this.querySelectorAll("button[data-resolved]")
    ).forEach((button) =>
      button.addEventListener("click", () => {
        this._resolved = button.dataset.resolved === "true";
        /** @type {NodeListOf<HTMLButtonElement>} */ (
          this.querySelectorAll("button[data-resolved]")
        ).forEach((choice) => {
          const selected =
            (choice.dataset.resolved === "true") === this._resolved;
          choice.setAttribute("aria-pressed", String(selected));
          choice.className = selected ? "btn-ink" : "btn-outline";
        });
        this._syncSave();
      }),
    );
    /** @type {HTMLButtonElement} */ (
      this.querySelector("button[data-save]")
    )?.addEventListener("click", () => this._save());
    /** @type {NodeListOf<HTMLButtonElement>} */ (
      this.querySelectorAll("button[data-separate-id]")
    ).forEach((button) => {
      button.disabled = this._dirty() || this._busy;
      button.addEventListener("click", () =>
        this._separate(button.dataset.separateId),
      );
    });
  }

  async _save() {
    if (this._busy || !this._valid()) return;
    const draftKey = this._draftKey();
    if (this._savingDraftKey !== draftKey) {
      this._savingDraftKey = draftKey;
      this._requestId = crypto.randomUUID();
    }
    this._busy = true;
    this._error = "";
    this.querySelector("dialog").close();
    await awaitOverlayUnwind(this._overlayId);
    const notice = showToast({
      title: t("details.saving"),
      message: "",
      duration: 0,
      icon: "clock",
    });
    try {
      const fields = {
        title: this._title.trim(),
        category: this._category,
        description: this._description.trim(),
      };
      let result;
      if (this._descriptionOnly && !this._details) {
        await saveCardDescription(this._problem, fields.description);
      } else if (this._descriptionOnly) {
        result = await editAnalysisCondition(
          this._problem.checkId,
          this._problem.artifactId,
          this._problem.conditionId,
          {
            ...fields,
            assessmentId: this._problem.assessmentId,
            ruleId: this._selected || undefined,
            revision: this._details.revision,
            requestId: this._requestId,
            ...(this._selected === CUSTOM_ACTION
              ? {
                  customAction: {
                    text: this._customDraft.trim(),
                    resolved: this._resolved,
                  },
                }
              : {}),
          },
        );
      } else if (this._selected === CUSTOM_ACTION) {
        result = await recordCustomTaskAction(this._clicked.taskId, {
          ...fields,
          text: this._customDraft.trim(),
          resolved: this._resolved,
          requestId: this._requestId,
        });
      } else {
        result = await updateTaskAction(
          this._clicked.taskId,
          this._selected !== this._originalSelected ||
            this._category !== this._originalCategory
            ? this._selected
            : undefined,
          fields.description,
          this._requestId,
          { title: fields.title, category: fields.category },
        );
      }
      if (result) syncCardDetails(this._problem, result, fields);
      notice?.close();
      this._baseline = this._draftKey();
      try {
        await this._onChanged();
      } catch {
        /* Saved edits remain authoritative if refreshing fails. */
      }
      showToast({
        title: t("details.saved"),
        message: "",
        tone: "success",
        icon: "circle-check",
      });
    } catch (error) {
      notice?.close();
      this._error = t(
        error?.status === 409 ? "details.conflict" : "taskDetails.saveError",
      );
      showToast({
        title: t("toast.actionSaveError.title"),
        message: this._error,
        duration: 0,
        tone: "error",
        icon: "triangle-exclamation",
        action: {
          label: t("details.reviewRetry"),
          run: () => {
            this._render();
            this._show();
          },
        },
      });
    } finally {
      this._busy = false;
    }
  }

  async _separate(taskId) {
    if (this._busy || this._dirty() || !this._details) return;
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
        this._originalSelected = this._selected;
        this._baseline = this._draftKey();
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

/** Description-only editing for generated cards in capture and pending questions. */
export function openDescriptionDetails(problem, trigger, onChanged) {
  const host = new TaskDetailsDialog();
  host._descriptionOnly = true;
  document.body.append(host);
  void host.open({ taskId: problem.taskId }, problem, trigger, onChanged);
}
