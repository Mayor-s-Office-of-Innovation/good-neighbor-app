// @ts-nocheck -- routed view; JSDoc ratchet follows established frontend migration.
import { loadError } from "./load-error.js";
import {
  contentTypeFor,
  MAX_IMAGE_FILE,
  MAX_DOCUMENT_FILE,
  MAX_TOTAL,
  MAX_FILES,
} from "../domain/attachment-files.js";
import "./complaint-view.css";
import { reserveMediaUpload } from "../services/upload-reservation.js";
import { currentRoute, navigate, setPopstateGuard } from "../router.js";
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
      navigate(fallback);
    });
  }

  async _renderList({ focusHeading = true, restoreFocus = "" } = {}) {
    this.innerHTML = `<div class="flow complaints"><p class="hint">${escapeHtml(t("common.loading"))}</p></div>`;
    try {
      const { complaints = [] } = await listComplaints();
      this.innerHTML = html`<div class="flow complaints">
        ${this._topbar(t("complaints.title"))}<button
          class="btn-ink complaints__new"
          id="log-complaint"
          type="button"
        >
          ${escapeHtml(t("complaints.log"))}
        </button>
        ${this._listActionError
          ? `<p class="complaint-compose__error" role="alert">${escapeHtml(t(this._listActionError))}</p>`
          : ""}
        <div class="complaints__list" role="list">
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
      this.innerHTML = html`<div class="flow complaints">
        ${this._topbar(t("complaints.title"))}
        <button class="btn-ink" type="button" data-new-complaint>
          ${escapeHtml(t("complaints.log"))}
        </button>
        ${loadError(t("complaints.loadError"), {
          retryAttribute: "data-retry-list",
        })}
      </div>`;
      this._bindBack();
      this.querySelector("[data-retry-list]")?.addEventListener(
        "click",
        () => void this._renderList(),
      );
      this.querySelector("[data-new-complaint]")?.addEventListener(
        "click",
        () => navigate("/complaints/new"),
      );
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
        <h2>
          ${escapeHtml(
            failed
              ? t("complaints.failed")
              : item.label || t("complaints.analyzing"),
          )}
        </h2>
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
    return html`<dialog
      id="complaint-delete"
      class="places-modal"
      aria-labelledby="complaint-delete-title"
    >
      <form method="dialog" class="places-modal__card">
        <div>
          <h2 id="complaint-delete-title">
            ${escapeHtml(t("complaints.delete.title"))}
          </h2>
          <p>${escapeHtml(t("complaints.delete.text"))}</p>
        </div>
        <div
          class="app-error app-error--panel"
          data-delete-error
          role="alert"
          hidden
        ></div>
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
    const error = dialog.querySelector("[data-delete-error]");
    error.hidden = true;
    dialog.showModal();
    const button = this.querySelector("#delete-confirm");
    button.onclick = async () => {
      button.disabled = true;
      error.hidden = true;
      try {
        await deleteComplaint(id);
        dialog.close();
        await this._renderList();
      } catch {
        error.textContent = `${t("notice.deleteFailed")} ${t("notice.retry")}.`;
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
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
      !draft.files.some((file) => file.status !== "registered");
    this.innerHTML = html`<div class="flow complaint-compose">
      <button
        class="complaint-compose__close"
        id="close-complaint"
        type="button"
        aria-label="${escapeAttr(t("common.close"))}"
      >
        <wa-icon name="xmark" aria-hidden="true"></wa-icon>
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
      ${draft.uploadError
        ? `<p class="app-error" role="alert">${escapeHtml(t(draft.uploadError))}</p>`
        : ""}
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
        ? `<p class="app-error app-error--panel app-error--warning" role="alert">${escapeHtml(t(draft.submitError))}</p>`
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
    this.querySelectorAll("[data-retry-file]").forEach((button) =>
      button.addEventListener("click", () => {
        const entry = draft.files.find(
          (file) => file.id === button.dataset.retryFile,
        );
        if (entry) void this._uploadEntry(entry, draft);
      }),
    );
    this.querySelectorAll("[data-replace-file]").forEach((button) =>
      button.addEventListener("click", () => {
        this._replacingId = button.dataset.replaceFile;
        this.querySelector("#complaint-files")?.click();
      }),
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
    navigate("/complaints");
  }

  _fileRow(entry) {
    const failed = entry.status === "error";
    return html`<div
      class="complaint-file ${failed ? "complaint-file--failed" : ""}"
    >
      <wa-icon
        name="${failed
          ? "triangle-exclamation"
          : entry.status === "registered"
            ? "circle-check"
            : "file-lines"}"
        aria-hidden="true"
      ></wa-icon>
      <div>
        <strong>${escapeHtml(entry.file.name)}</strong>
        ${entry.status === "uploading"
          ? `<progress max="100" value="${entry.progress || 0}"></progress>`
          : ""}
        ${failed
          ? `<p class="complaint-file__error" role="alert">${escapeHtml(t(entry.tooLarge ? "notice.tooLarge" : "notice.uploadFailed"))}
          <button class="btn-link" type="button" ${entry.tooLarge ? "data-replace-file" : "data-retry-file"}="${escapeAttr(entry.id)}">${escapeHtml(t(entry.tooLarge ? "notice.replace" : "notice.retry"))}</button></p>`
          : ""}
      </div>
      <button
        type="button"
        data-remove-file="${escapeAttr(entry.id)}"
        aria-label="${escapeAttr(
          t("complaints.upload.remove", { name: entry.file.name }),
        )}"
      >
        <wa-icon name="xmark" aria-hidden="true"></wa-icon>
      </button>
    </div>`;
  }

  async _selectFiles(files) {
    const activeDraft = draft;
    const replacing = this._replacingId;
    this._replacingId = null;
    const remaining = activeDraft.files.filter(
      (entry) => entry.id !== replacing,
    );
    const acceptedSize = (file) =>
      file.size <= (isDocument(file) ? MAX_DOCUMENT_FILE : MAX_IMAGE_FILE)
        ? file.size
        : 0;
    if (
      remaining.length + files.length > MAX_FILES ||
      remaining.reduce((n, entry) => n + acceptedSize(entry.file), 0) +
        files.reduce((n, file) => n + acceptedSize(file), 0) >
        MAX_TOTAL
    ) {
      activeDraft.uploadError = "complaints.upload.limit";
      this._renderDraft();
      return;
    }
    if (replacing && !(await this._removeFile(replacing))) return;
    activeDraft.uploadError = "";
    if (draft !== activeDraft || !this.isConnected) return;
    // Reserve the entire batch before awaiting uploads so another selection
    // cannot bypass the attachment count/total-byte limits.
    const entries = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      tooLarge:
        file.size > (isDocument(file) ? MAX_DOCUMENT_FILE : MAX_IMAGE_FILE),
      status:
        file.size > (isDocument(file) ? MAX_DOCUMENT_FILE : MAX_IMAGE_FILE)
          ? "error"
          : "pending",
    }));
    activeDraft.files.push(...entries);
    this._renderDraft();
    for (const entry of entries) {
      if (draft !== activeDraft || !this.isConnected) break;
      if (!entry.tooLarge) await this._uploadEntry(entry, activeDraft);
    }
  }

  async _uploadEntry(entry, activeDraft) {
    if (entry.status === "uploading" || entry.tooLarge) return;
    entry.status = "uploading";
    activeDraft.uploading += 1;
    this._renderDraft();
    const controller = new AbortController();
    this._aborters.set(entry.id, controller);
    const file = entry.file;
    const contentType = contentTypeFor(file);
    try {
      if (entry.registrationUncertain) {
        const saved = await getComplaint(activeDraft.complaintId);
        if (
          saved.artifacts?.some(
            (row) =>
              row.artifactId === entry.artifactId &&
              row.contentType === contentType &&
              Number(row.contentLength) === file.size,
          )
        ) {
          entry.status = "registered";
          entry.progress = 100;
          return;
        }
      }
      if (!entry.signed || entry.signedUntil <= Date.now()) {
        entry.signed = await reserveMediaUpload(
          `complaint:${activeDraft.complaintId}:attachment:${entry.id}`,
          file,
          (uploadRequestId) =>
            presignComplaintArtifact(
              activeDraft.complaintId,
              { contentType, contentLength: file.size, uploadRequestId },
              controller.signal,
            ),
          { contentType },
        );
        entry.signedUntil =
          Date.now() +
          Math.max(0, Number(entry.signed.expiresIn || 300) - 5) * 1000;
      }
      const signed = entry.signed;
      controller.signal.throwIfAborted();
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
      controller.signal.throwIfAborted();
      entry.registrationUncertain = true;
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
      entry.registrationUncertain = false;
      entry.status = "registered";
      entry.progress = 100;
    } catch {
      entry.status = "error";
    } finally {
      activeDraft.uploading -= 1;
      this._aborters.delete(entry.id);
      if (draft === activeDraft && this.isConnected) this._renderDraft();
    }
  }

  async _removeFile(id) {
    const activeDraft = draft;
    const entry = activeDraft.files.find((file) => file.id === id);
    this._aborters.get(id)?.abort();
    try {
      if (
        entry?.artifactId &&
        (entry.status === "registered" || entry.registrationUncertain)
      )
        await deleteComplaintArtifact(
          activeDraft.complaintId,
          entry.artifactId,
        ).catch((error) => {
          // Registration may have failed before an artifact row was created.
          if (
            error.status !== 404 ||
            error.body?.error !== "artifact_not_found"
          )
            throw error;
        });
      activeDraft.files = activeDraft.files.filter((file) => file.id !== id);
      return true;
    } catch {
      activeDraft.uploadError = "complaints.upload.removeError";
      return false;
    } finally {
      if (draft === activeDraft && this.isConnected) this._renderDraft();
    }
  }

  async _submit() {
    const activeDraft = draft;
    const button = this.querySelector("#submit-complaint");
    button.disabled = true;
    activeDraft.submitError = "";
    try {
      await createComplaint({
        complaintId: activeDraft.complaintId,
        description: activeDraft.description.trim(),
      });
      if (draft !== activeDraft) return;
      draft = null;
      if (this.isConnected) navigate("/complaints");
    } catch {
      activeDraft.submitError = "complaints.submitError";
      if (draft === activeDraft && this.isConnected) this._renderDraft();
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
        ${loadError(t("complaints.detailError"), {
          retryAttribute: "data-retry-detail",
        })}
      </div>`;
      this._bindBack("/complaints");
      this.querySelector("[data-retry-detail]")?.addEventListener(
        "click",
        () => void this._renderDetail(id),
      );
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
