// @ts-nocheck -- routed view; JSDoc ratchet follows established frontend migration.
import "./complaint-view.css";
import { currentRoute, navigate } from "../router.js";
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

const ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.txt,.doc,.docx";
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 25 * 1024 * 1024;
const MAX_FILES = 5;
const DESCRIPTION_MAX = 4000;
let draft = null;

const contentTypeFor = (file) =>
  file.type ||
  {
    heic: "image/heic",
    heif: "image/heif",
    pdf: "application/pdf",
    txt: "text/plain",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  }[file.name.split(".").pop()?.toLowerCase()] ||
  "application/octet-stream";

const freshDraft = () => ({
  complaintId: crypto.randomUUID(),
  description: "",
  files: [],
  uploading: 0,
  describing: false,
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
  }

  _topbar(title) {
    return html`<header class="topbar">
      <button
        class="topbar__back"
        type="button"
        data-back
        aria-label="${escapeAttr(t("common.back"))}"
      >
        <span class="complaints__back-icon" aria-hidden="true"></span>
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
      navigate(fallback);
    });
  }

  async _renderList() {
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
      this.querySelectorAll("[data-complaint-row]").forEach((row) =>
        row.addEventListener("click", () =>
          navigate(
            `/complaints/${encodeURIComponent(row.dataset.complaintRow)}`,
          ),
        ),
      );
      this.querySelectorAll("[data-complaint-row]").forEach((row) =>
        row.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          navigate(
            `/complaints/${encodeURIComponent(row.dataset.complaintRow)}`,
          );
        }),
      );
      this.querySelectorAll("[data-retry]").forEach((button) =>
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          button.disabled = true;
          await retryComplaint(button.dataset.retry);
          await this._renderList();
        }),
      );
      this.querySelectorAll("[data-delete]").forEach((button) =>
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          this._confirmDelete(button.dataset.delete);
        }),
      );
      if (complaints.some((item) => item.status === "analyzing"))
        this._pollTimer = setTimeout(() => this._renderList(), 2500);
      this.querySelector("h1")?.focus();
    } catch {
      this.innerHTML = html`<div class="flow complaints">
        ${this._topbar(t("complaints.title"))}
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
      tabindex="0"
    >
      <div>
        <h2>${escapeHtml(failed ? t("complaints.failed") : item.label)}</h2>
        <p>${escapeHtml(formatMonthDayTime(item.createdAt))}</p>
      </div>
      <div class="complaint-row__actions">
        ${failed
          ? `<button class="btn-outline btn-outline--sm" type="button" data-retry="${escapeAttr(item.complaintId)}">${escapeHtml(t("complaints.retry"))}</button>`
          : ""}${canDelete
          ? `<button class="complaint-row__delete" type="button" data-delete="${escapeAttr(item.complaintId)}" aria-label="${escapeAttr(t("complaints.delete.aria", { label: item.label }))}"><wa-icon name="trash" aria-hidden="true"></wa-icon></button>`
          : ""}
      </div>
    </article>`;
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
        class="complaint-compose__close"
        id="close-complaint"
        type="button"
        aria-label="${escapeAttr(t("common.close"))}"
      >
        <span aria-hidden="true"></span>
      </button>
      <div class="complaint-compose__intro">
        <h1 tabindex="-1">${escapeHtml(t("complaints.compose.title"))}</h1>
        <p>${escapeHtml(t("complaints.compose.subtitle"))}</p>
      </div>
      <div class="complaint-upload-section">
        <label class="complaint-upload-button" for="complaint-files">
          <span aria-hidden="true">+</span>
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
      textarea?.scrollIntoView({ behavior: "smooth", block: "center" });
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
    navigate("/complaints");
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
    if (
      draft.files.length + files.length > MAX_FILES ||
      files.some((file) => file.size > MAX_FILE) ||
      draft.files.reduce((n, entry) => n + entry.file.size, 0) +
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
      draft.files.push(entry);
      draft.uploading += 1;
      this._renderDraft();
      const controller = new AbortController();
      this._aborters.set(entry.id, controller);
      try {
        const contentType = contentTypeFor(file);
        const signed = await presignComplaintArtifact(draft.complaintId, {
          contentType,
          contentLength: file.size,
        });
        entry.artifactId = signed.artifactId;
        entry.s3Key = signed.s3Key;
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
        await registerComplaintArtifact(draft.complaintId, {
          artifactId: entry.artifactId,
          s3Key: entry.s3Key,
          name: file.name,
          contentType,
          contentLength: file.size,
        });
        entry.status = "registered";
        entry.progress = 100;
      } catch (error) {
        if (error.name !== "AbortError") entry.status = "error";
      } finally {
        draft.uploading -= 1;
        this._aborters.delete(entry.id);
        this._renderDraft();
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
    await createComplaint({
      complaintId: draft.complaintId,
      description: draft.description.trim(),
    });
    draft = null;
    showComplaintLoggedToast();
    navigate("/complaints");
  }

  async _renderDetail(id) {
    this.innerHTML = `<div class="flow complaints"><p>${escapeHtml(t("common.loading"))}</p></div>`;
    const { complaint, artifacts } = await getComplaint(id);
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
    </div>`;
    this._bindBack("/complaints");
    this.querySelectorAll("[data-media]").forEach((button) =>
      button.addEventListener("click", async () => {
        const { downloadUrl } = await getComplaintMediaUrl(
          id,
          button.dataset.media,
        );
        window.open(downloadUrl, "_blank", "noopener");
      }),
    );
    for (const image of this.querySelectorAll("[data-image]")) {
      try {
        const file = artifacts.find(
          (item) => item.artifactId === image.dataset.image,
        );
        const { downloadUrl } = await getComplaintMediaUrl(
          id,
          image.dataset.image,
        );
        image.innerHTML = `<img src="${escapeAttr(downloadUrl)}" alt="${escapeAttr(file.name)}" />`;
      } catch {
        image.textContent = t("complaints.fileUnavailable");
      }
    }
  }
}

customElements.define("complaint-view", ComplaintView);
