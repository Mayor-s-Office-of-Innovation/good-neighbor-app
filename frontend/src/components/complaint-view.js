// @ts-nocheck -- routed view; JSDoc ratchet follows established frontend migration.
import {
  contentTypeFor,
  MAX_IMAGE_FILE,
  MAX_DOCUMENT_FILE,
  MAX_TOTAL,
  MAX_FILES,
} from "../domain/attachment-files.js";
import "./complaint-view.css";
import "./care-work.css";
import { careHeader } from "./care-work.templates.js";
import { reserveMediaUpload } from "../services/upload-reservation.js";
import {
  backOrNavigate,
  currentRoute,
  navigate,
  setPopstateGuard,
} from "../router.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { formatMonthDayTime } from "../i18n/dates.js";
import {
  createComplaint,
  deleteComplaint,
  deleteComplaintArtifact,
  getComplaint,
  getComplaintMediaUrl,
  listComplaints,
  presignComplaintArtifact,
  putMediaWithProgress,
  registerComplaintArtifact,
  retryComplaint,
} from "../services/api.js";
import { showComplaintLoggedToast } from "../state/toasts.js";

const ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.txt";
const DESCRIPTION_MAX = 4000;
let draft = null;

const isDocument = (file) =>
  ["application/pdf", "text/plain"].includes(contentTypeFor(file));

const freshDraft = () => ({
  complaintId: crypto.randomUUID(),
  description: "",
  files: [],
  uploading: 0,
  describing: false,
  submitError: "",
});

class ComplaintView extends HTMLElement {
  connectedCallback() {
    this._route = currentRoute();
    this._aborters = new Map();
    this._beforeUnload = (event) => {
      if (!draft?.uploading) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", this._beforeUnload);
    if (this._route === "/complaints/new") {
      draft ||= freshDraft();
      this._removePopstateGuard = setPopstateGuard(() => {
        if (!draft?.uploading) return true;
        const leave = window.confirm(t("complaints.upload.leave"));
        if (leave) draft = null;
        return leave;
      });
      this._renderDraft();
      return;
    }
    const match = /^\/complaints\/([^/]+)$/.exec(this._route);
    if (match) void this._renderDetail(decodeURIComponent(match[1]));
    else void this._renderList();
  }

  disconnectedCallback() {
    for (const controller of this._aborters?.values() || []) controller.abort();
    clearTimeout(this._pollTimer);
    window.removeEventListener("beforeunload", this._beforeUnload);
    this._removePopstateGuard?.();
  }

  _topbar(title) {
    return html`<header class="topbar">
      <button
        class="topbar__back"
        type="button"
        data-back
        aria-label="${escapeAttr(t("common.back"))}"
      >
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </button>
      <div class="topbar__titles">
        <h1 class="topbar__title" tabindex="-1">${escapeHtml(title)}</h1>
      </div>
    </header>`;
  }

  _bindBack(fallback = "/today") {
    this.querySelector("[data-back]")?.addEventListener("click", () => {
      if (draft?.uploading && !window.confirm(t("complaints.upload.leave")))
        return;
      if (draft?.uploading) draft = null;
      backOrNavigate(fallback);
    });
  }

  async _renderList({ focusHeading = true, restoreFocus = "" } = {}) {
    if (!this.querySelector(".complaints__list")) {
      this.innerHTML = html`<div class="care-work complaints">
        ${careHeader(t("complaints.title"), true)}
        <p class="care-subtitle">${escapeHtml(t("complaints.subtitle"))}</p>
        <hr class="splash-rule" />
        <button class="btn-ink complaints__new" type="button" disabled>
          ${escapeHtml(t("complaints.log"))}
        </button>
        <p class="hint" role="status">${escapeHtml(t("common.loading"))}</p>
      </div>`;
      this._bindBack();
    }
    try {
      const { complaints = [] } = await listComplaints();
      this.innerHTML = html`<div class="care-work complaints">
        ${careHeader(t("complaints.title"), true)}
        <p class="care-subtitle">${escapeHtml(t("complaints.subtitle"))}</p>
        <hr class="splash-rule" />
        <button
          class="btn-ink complaints__new"
          id="log-complaint"
          type="button"
        >
          ${escapeHtml(t("complaints.log"))}
        </button>
        ${this._listActionError
          ? `<p class="complaint-compose__error" role="alert">${escapeHtml(t(this._listActionError))}</p>`
          : ""}
        <div class="complaints__list" ${complaints.length ? 'role="list"' : ""}>
          ${complaints.length
            ? complaints.map((item) => this._row(item)).join("")
            : `<p class="complaints__empty">${escapeHtml(t("complaints.empty"))}</p>`}
        </div>
        ${this._deleteDialog()}
      </div>`;
      this._bindBack();
      this.querySelector("#log-complaint")?.addEventListener("click", () => {
        draft = freshDraft();
        navigate("/complaints/new");
      });
      this.querySelectorAll("[data-complaint-link]").forEach((link) =>
        link.addEventListener("click", (event) => {
          event.preventDefault();
          navigate(link.getAttribute("href"));
        }),
      );
      this.querySelectorAll("[data-retry]").forEach((button) =>
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          button.disabled = true;
          try {
            await retryComplaint(button.dataset.retry);
            this._listActionError = "";
          } catch {
            this._listActionError = "complaints.retryError";
          }
          await this._renderList({ focusHeading: false });
        }),
      );
      this.querySelectorAll("[data-delete]").forEach((button) =>
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this._confirmDelete(button.dataset.delete);
        }),
      );
      if (complaints.some((item) => item.status === "analyzing"))
        this._schedulePoll();
      if (restoreFocus) this.querySelector(restoreFocus)?.focus();
      else if (focusHeading) this.querySelector("h1")?.focus();
    } catch {
      this.innerHTML = html`<div class="care-work complaints">
        ${careHeader(t("complaints.title"), true)}
        <p class="care-subtitle">${escapeHtml(t("complaints.subtitle"))}</p>
        <hr class="splash-rule" />
        <p role="alert">${escapeHtml(t("complaints.loadError"))}</p>
      </div>`;
      this._bindBack();
    }
  }

  _row(item) {
    const failed = item.status === "analysis_failed";
    const canDelete = item.status !== "analyzing";
    return html`<article
      class="complaint-row"
      role="listitem"
      data-complaint-row="${escapeAttr(item.complaintId)}"
    >
      <a
        class="complaint-row__link"
        data-complaint-link="${escapeAttr(item.complaintId)}"
        href="/complaints/${encodeURIComponent(item.complaintId)}"
      >
        <h2>${escapeHtml(failed ? t("complaints.failed") : item.label)}</h2>
        <p>${escapeHtml(formatMonthDayTime(item.createdAt))}</p>
      </a>
      <div class="complaint-row__actions">
        ${failed
          ? `<button class="btn-outline btn-outline--sm" type="button" data-retry="${escapeAttr(item.complaintId)}">${escapeHtml(t("complaints.retry"))}</button>`
          : ""}${canDelete
          ? `<button class="complaint-row__delete" type="button" data-delete="${escapeAttr(item.complaintId)}" aria-label="${escapeAttr(t("complaints.delete.aria", { label: item.label }))}"><wa-icon name="trash" aria-hidden="true"></wa-icon></button>`
          : ""}
      </div>
    </article>`;
  }

  _schedulePoll() {
    clearTimeout(this._pollTimer);
    this._pollTimer = setTimeout(() => {
      if (this.querySelector("#complaint-delete")?.open) {
        this._schedulePoll();
        return;
      }
      const active = document.activeElement;
      let restoreFocus = "";
      if (active instanceof HTMLElement && this.contains(active)) {
        for (const attribute of [
          "data-complaint-link",
          "data-retry",
          "data-delete",
        ]) {
          const value = active.getAttribute(attribute);
          if (value) {
            restoreFocus = `[${attribute}="${CSS.escape(value)}"]`;
            break;
          }
        }
      }
      void this._renderList({ focusHeading: false, restoreFocus });
    }, 2500);
  }

  _deleteDialog() {
    return html`<dialog id="complaint-delete" class="places-modal">
      <form method="dialog" class="places-modal__card">
        <div>
          <h2>${escapeHtml(t("complaints.delete.title"))}</h2>
          <p>${escapeHtml(t("complaints.delete.text"))}</p>
        </div>
        <div class="places-modal__actions">
          <button class="btn-ink" id="delete-confirm" type="button">
            ${escapeHtml(t("complaints.delete.confirm"))}</button
          ><button class="btn-outline" type="submit">
            ${escapeHtml(t("common.cancel"))}
          </button>
        </div>
      </form>
    </dialog>`;
  }

  _confirmDelete(id) {
    const dialog = this.querySelector("#complaint-delete");
    dialog.showModal();
    this.querySelector("#delete-confirm").onclick = async () => {
      await deleteComplaint(id);
      dialog.close();
      await this._renderList();
    };
  }

  _renderDraft() {
    const ready =
      draft.files.length > 0 &&
      draft.files.every((file) => file.status === "registered") &&
      draft.uploading === 0;
    const canSubmit =
      (ready || draft.description.trim().length >= 5) &&
      draft.uploading === 0 &&
      !draft.files.some((file) => file.status === "error");
    this.innerHTML = html`<div class="flow complaint-compose">
      <button
        class="complaint-compose__back"
        id="close-complaint"
        type="button"
        aria-label="${escapeAttr(t("common.back"))}"
      >
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </button>
      <div class="complaint-compose__intro">
        <h1 tabindex="-1">${escapeHtml(t("complaints.compose.title"))}</h1>
        <p>${escapeHtml(t("complaints.compose.subtitle"))}</p>
      </div>
      <div class="complaint-upload-section">
        <label class="complaint-upload-button" for="complaint-files">
          <wa-icon name="circle-plus" aria-hidden="true"></wa-icon>
          <span class="visually-hidden"
            >${escapeHtml(t("complaints.upload.title"))}</span
          >
        </label>
        <div class="complaint-upload-copy">
          <strong>${escapeHtml(t("complaints.upload.title"))}</strong>
          <p>${escapeHtml(t("complaints.upload.help"))}</p>
        </div>
        <input id="complaint-files" type="file" multiple accept="${ACCEPT}" />
      </div>
      <div class="complaint-files">
        ${draft.files.map((file) => this._fileRow(file)).join("")}
      </div>
      ${draft.describing
        ? this._descriptionField()
        : html`<button
            class="complaint-describe-link"
            id="describe-complaint"
            type="button"
          >
            <wa-icon name="pen" aria-hidden="true"></wa-icon>
            ${escapeHtml(t("complaints.describe"))}
          </button>`}
      ${draft.submitError
        ? `<p class="complaint-compose__error" role="alert">${escapeHtml(t(draft.submitError))}</p>`
        : ""}
      <button
        class="btn-ink"
        id="submit-complaint"
        type="button"
        ${canSubmit ? "" : "disabled"}
      >
        ${escapeHtml(t("complaints.submit"))}
      </button>
    </div>`;
    this.querySelector("#close-complaint").addEventListener("click", () =>
      this._closeComposer(),
    );
    this.querySelector("#describe-complaint")?.addEventListener("click", () => {
      draft.describing = true;
      this._renderDraft();
      const textarea = this.querySelector("#complaint-description");
      textarea?.focus();
      textarea?.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
    this.querySelector("#complaint-files").addEventListener("change", (event) =>
      this._selectFiles([...event.target.files]),
    );
    this.querySelectorAll("[data-remove-file]").forEach((button) =>
      button.addEventListener("click", () =>
        this._removeFile(button.dataset.removeFile),
      ),
    );
    this.querySelector("#submit-complaint").addEventListener("click", () =>
      this._submit(),
    );
    const textarea = this.querySelector("#complaint-description");
    textarea?.addEventListener("input", () => {
      draft.description = textarea.value.slice(0, DESCRIPTION_MAX);
      const submit = this.querySelector("#submit-complaint");
      const filesReady =
        draft.files.length > 0 &&
        draft.files.every((file) => file.status === "registered");
      if (submit) {
        submit.disabled =
          draft.uploading !== 0 ||
          draft.files.some((file) => file.status === "error") ||
          (!filesReady && draft.description.trim().length < 5);
      }
    });
    this.querySelector("h1")?.focus();
  }

  _descriptionField() {
    return html`<label
      class="complaint-description"
      for="complaint-description"
    >
      <strong>${escapeHtml(t("complaints.describe.label"))}</strong>
      <textarea
        id="complaint-description"
        maxlength="${DESCRIPTION_MAX}"
        rows="3"
        placeholder="${escapeAttr(t("complaints.describe.placeholder"))}"
      >
${escapeHtml(draft.description)}</textarea
      >
    </label>`;
  }

  _closeComposer() {
    if (draft?.uploading && !window.confirm(t("complaints.upload.leave")))
      return;
    draft = null;
    backOrNavigate("/complaints");
  }

  _fileRow(file) {
    return html`<div class="complaint-file">
      <wa-icon
        name="${file.file.type.startsWith("image/") ? "image" : "file-lines"}"
        aria-hidden="true"
      ></wa-icon>
      <div>
        <strong>${escapeHtml(file.file.name)}</strong
        ><progress max="100" value="${file.progress || 0}"></progress
        ><small>${escapeHtml(t(`complaints.upload.${file.status}`))}</small>
      </div>
      <button
        type="button"
        data-remove-file="${escapeAttr(file.id)}"
        aria-label="${escapeAttr(
          t("complaints.upload.remove", { name: file.file.name }),
        )}"
      >
        <wa-icon name="xmark" aria-hidden="true"></wa-icon>
      </button>
    </div>`;
  }

  async _selectFiles(files) {
    const activeDraft = draft;
    if (
      files.some((file) => isDocument(file) && file.size > MAX_DOCUMENT_FILE)
    ) {
      alert(t("complaints.upload.documentLimit"));
      return;
    }
    if (
      activeDraft.files.length + files.length > MAX_FILES ||
      files.some((file) => !isDocument(file) && file.size > MAX_IMAGE_FILE) ||
      activeDraft.files.reduce((n, entry) => n + entry.file.size, 0) +
        files.reduce((n, file) => n + file.size, 0) >
        MAX_TOTAL
    ) {
      alert(t("complaints.upload.limit"));
      return;
    }
    for (const file of files) {
      const entry = {
        id: crypto.randomUUID(),
        file,
        progress: 0,
        status: "uploading",
      };
      activeDraft.files.push(entry);
      activeDraft.uploading += 1;
      this._renderDraft();
      const controller = new AbortController();
      this._aborters.set(entry.id, controller);
      try {
        const contentType = contentTypeFor(file);
        const signed = await reserveMediaUpload(
          `complaint:${activeDraft.complaintId}:attachment:${entry.id}`,
          file,
          (uploadRequestId) =>
            presignComplaintArtifact(
              activeDraft.complaintId,
              {
                contentType,
                contentLength: file.size,
                uploadRequestId,
              },
              controller.signal,
            ),
          { contentType },
        );
        if (controller.signal.aborted)
          throw new DOMException("Upload cancelled", "AbortError");
        entry.artifactId = signed.artifactId;
        entry.s3Key = signed.s3Key;
        try {
          await putMediaWithProgress(
            signed.uploadUrl,
            file,
            signed.uploadHeaders,
            (value) => {
              entry.progress = value;
              this.querySelector(`[data-remove-file="${entry.id}"]`)
                ?.closest(".complaint-file")
                ?.querySelector("progress")
                ?.setAttribute("value", value);
            },
            controller.signal,
          );
        } catch (error) {
          if (error?.status !== 412) throw error;
        }
        await registerComplaintArtifact(
          activeDraft.complaintId,
          {
            artifactId: entry.artifactId,
            s3Key: entry.s3Key,
            name: file.name,
            contentType,
            contentLength: file.size,
          },
          controller.signal,
        );
        entry.status = "registered";
        entry.progress = 100;
      } catch (error) {
        if (error.name !== "AbortError") entry.status = "error";
      } finally {
        activeDraft.uploading -= 1;
        this._aborters.delete(entry.id);
        if (draft === activeDraft && this.isConnected) this._renderDraft();
      }
    }
  }

  async _removeFile(id) {
    const entry = draft.files.find((file) => file.id === id);
    this._aborters.get(id)?.abort();
    if (entry?.artifactId && entry.status === "registered")
      await deleteComplaintArtifact(draft.complaintId, entry.artifactId);
    draft.files = draft.files.filter((file) => file.id !== id);
    this._renderDraft();
  }

  async _submit() {
    const button = this.querySelector("#submit-complaint");
    button.disabled = true;
    draft.submitError = "";
    try {
      await createComplaint({
        complaintId: draft.complaintId,
        description: draft.description.trim(),
      });
      draft = null;
      showComplaintLoggedToast();
      backOrNavigate("/complaints");
    } catch {
      draft.submitError = "complaints.submitError";
      this._renderDraft();
    }
  }

  async _renderDetail(id) {
    this.innerHTML = `<div class="flow complaints"><p>${escapeHtml(t("common.loading"))}</p></div>`;
    let response;
    try {
      response = await getComplaint(id);
    } catch {
      this.innerHTML = html`<div class="flow complaints">
        ${this._topbar(t("complaints.title"))}
        <p role="alert">${escapeHtml(t("complaints.detailError"))}</p>
      </div>`;
      this._bindBack("/complaints");
      this.querySelector("h1")?.focus();
      return;
    }
    const { complaint, artifacts } = response;
    this.innerHTML = html`<div class="flow complaints">
      ${this._topbar(complaint.label)}
      <p class="complaint-detail__time">
        ${escapeHtml(formatMonthDayTime(complaint.createdAt))}
      </p>
      <p class="complaint-detail__copy">
        ${escapeHtml(complaint.detail || "")}
      </p>
      <ul class="complaint-detail__files">
        ${artifacts
          .map((file) =>
            file.contentType.startsWith("image/")
              ? `<li class="complaint-detail__image" data-image="${escapeAttr(file.artifactId)}"><span>${escapeHtml(t("common.loading"))}</span></li>`
              : `<li><button type="button" data-media="${escapeAttr(file.artifactId)}">${escapeHtml(file.name)}</button></li>`,
          )
          .join("")}
      </ul>
      <p
        class="complaint-compose__error"
        data-media-error
        role="alert"
        hidden
      ></p>
    </div>`;
    this._bindBack("/complaints");
    this.querySelectorAll("[data-media]").forEach((button) =>
      button.addEventListener("click", async () => {
        button.disabled = true;
        const error = this.querySelector("[data-media-error]");
        try {
          const { downloadUrl } = await getComplaintMediaUrl(
            id,
            button.dataset.media,
          );
          window.open(downloadUrl, "_blank", "noopener");
          error.hidden = true;
        } catch {
          error.textContent = t("complaints.fileOpenError");
          error.hidden = false;
        } finally {
          button.disabled = false;
        }
      }),
    );
    for (const image of this.querySelectorAll("[data-image]")) {
      try {
        const file = artifacts.find(
          (item) => item.artifactId === image.dataset.image,
        );
        const { downloadUrl, thumbnailUrl } = await getComplaintMediaUrl(
          id,
          image.dataset.image,
        );
        // A thumbnail saves downloading the full image for a small tile.
        image.innerHTML = `<button type="button" class="complaint-detail__photo" data-photo-lightbox data-photo-no-location data-full-src="${escapeAttr(downloadUrl)}"><img src="${escapeAttr(thumbnailUrl || downloadUrl)}" alt="${escapeAttr(file.name)}" loading="lazy" decoding="async" /></button>`;
        const img = image.querySelector("img");
        // Fall back once, so a missing thumbnail never leaves a broken image.
        img.addEventListener("error", () => {
          if (img.getAttribute("src") !== downloadUrl) img.src = downloadUrl;
        });
      } catch {
        image.textContent = t("complaints.fileUnavailable");
      }
    }
  }
}

customElements.define("complaint-view", ComplaintView);
