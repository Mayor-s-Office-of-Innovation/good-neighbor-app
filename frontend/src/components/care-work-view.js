import "./care-work.css";
import { announceScreenHeading } from "../screen-focus.js";
import {
  currentRoute,
  navigate,
  replaceRoute,
  backOrNavigate,
  setPopstateGuard,
  captureRouteReturn,
} from "../router.js";
import { getSite } from "../db.js";
import { t } from "../i18n/i18n.js";
import { escapeHtml } from "../lib/html.js";
import { CARE_WORK_TYPES, MAX_CARE_PHOTOS } from "../domain/care-work.js";
import {
  careHeader,
  careList,
  careOptions,
  careCompose,
  careDetail,
} from "./care-work.templates.js";
import {
  listCareWork,
  getCareWork,
  createCareWork,
  presignCarePhoto,
  getCarePhoto,
  putMediaWithProgress,
} from "../services/api.js";
import { showToast } from "../state/toasts.js";

/** @type {any} Live-only, Site-bound draft; never an offline queue. */
let draft = null;
/** @type {any} Provides immediate read-your-write while GSI1 catches up. */
let lastSaved = null;
function clearDraft() {
  for (const entry of draft?.files || []) URL.revokeObjectURL(entry.url);
  draft = null;
}
/** @param {string} siteId */
function freshDraft(siteId) {
  return {
    siteId,
    workId: crypto.randomUUID(),
    kind: "",
    note: "",
    files: [],
    error: "",
    payload: null,
    returnToList: null,
  };
}

export class CareWorkView extends HTMLElement {
  _busy = false;
  _route = "";
  _siteId = "";
  /** @type {(() => void) | undefined} */
  _removeGuard;
  /** @type {AbortController | undefined} */
  _controller;
  _beforeUnload = (event) => {
    if (this._busy || draft?.files.length || draft?.note) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  async connectedCallback() {
    this._route = currentRoute();
    this.classList.add("care-work");
    this.innerHTML = `${careHeader(t("care.title"), true)}<p role="status">${escapeHtml(t("care.loading"))}</p>`;
    const site = await getSite();
    if (!this.isConnected) return;
    this._siteId = site?.siteId || "";
    if (draft && draft.siteId !== this._siteId) clearDraft();
    if (lastSaved?.siteId !== this._siteId) lastSaved = null;
    if (this._route === "/care-work/new") {
      draft ||= freshDraft(this._siteId);
      this.innerHTML = careOptions();
      this._bindBack("/care-work");
      this.querySelectorAll("[data-kind]").forEach((button) =>
        button.addEventListener("click", () => {
          if (draft.payload) {
            navigate(`/care-work/new/${draft.payload.kind}`);
            return;
          }
          draft.kind = button.getAttribute("data-kind");
          draft.error = "";
          navigate(`/care-work/new/${draft.kind}`);
        }),
      );
    } else if (this._route.startsWith("/care-work/new/")) {
      const kind = this._route.split("/").pop();
      if (![...CARE_WORK_TYPES, "other"].includes(kind)) {
        replaceRoute("/care-work");
        return;
      }
      draft ||= freshDraft(this._siteId);
      draft.kind = kind;
      this._removeGuard = setPopstateGuard(() => !this._busy);
      window.addEventListener("beforeunload", this._beforeUnload);
      this._renderCompose();
    } else if (this._route === "/care-work") {
      clearDraft();
      await this._loadList();
    } else {
      await this._loadDetail(this._route.split("/").pop());
    }
    announceScreenHeading(this, "h1");
  }
  disconnectedCallback() {
    this._controller?.abort();
    this._removeGuard?.();
    window.removeEventListener("beforeunload", this._beforeUnload);
  }
  _bindBack(fallback) {
    this.querySelector("[data-back]")?.addEventListener("click", () => {
      if (!this._busy) backOrNavigate(fallback);
    });
  }
  _bindList() {
    this._bindBack("/today");
    this.querySelector("[data-new]")?.addEventListener("click", () => {
      clearDraft();
      draft = freshDraft(this._siteId);
      draft.returnToList = captureRouteReturn("/care-work");
      navigate("/care-work/new");
    });
    this.querySelectorAll("[data-work]").forEach((button) =>
      button.addEventListener("click", () =>
        navigate(`/care-work/${button.getAttribute("data-work")}`),
      ),
    );
  }
  async _loadList() {
    this.innerHTML = careList([], true);
    this._bindList();
    try {
      // Read all bounded API pages before counting groups, so a date never
      // displays a partial count at a page boundary.
      const items = new Map();
      let nextToken = "";
      do {
        const page = await listCareWork(nextToken);
        if (!this.isConnected) return;
        page.work.forEach((item) => items.set(item.workId, item));
        nextToken = page.nextToken || "";
      } while (nextToken);
      if (lastSaved) items.set(lastSaved.work.workId, lastSaved.work);
      this.innerHTML = careList([...items.values()]);
      this._bindList();
    } catch {
      if (this.isConnected) this._loadError(() => this._loadList());
    }
  }
  _loadError(retry) {
    this.innerHTML = `${careHeader(t("care.title"))}<p role="alert">${escapeHtml(t("care.loadError"))}</p><button type="button" class="btn-outline" data-retry>${escapeHtml(t("care.retry"))}</button>`;
    this._bindBack("/care-work");
    this.querySelector("[data-retry]")?.addEventListener("click", retry);
  }
  _renderCompose() {
    this.innerHTML = careCompose(draft, this._busy);
    this._bindBack("/care-work/new");
    const note = /** @type {any} */ (this.querySelector("#care-note"));
    note.value = draft.note;
    note.disabled = this._busy || Boolean(draft.payload);
    note.addEventListener("input", () => {
      draft.note = note.value;
      const save = /** @type {HTMLButtonElement} */ (
        this.querySelector("[data-save]")
      );
      save.disabled =
        this._busy || (draft.kind === "other" && !draft.note.trim());
    });
    const input = /** @type {HTMLInputElement} */ (
      this.querySelector("#care-photo-input")
    );
    this.querySelector("[data-add-photo]")?.addEventListener("click", () => {
      if (!draft.payload) input.click();
    });
    input.addEventListener("change", () => this._addFiles([...input.files]));
    this.querySelectorAll("[data-remove]").forEach((button) =>
      button.addEventListener("click", () => {
        if (draft.payload || this._busy) return;
        const index = Number(button.getAttribute("data-remove"));
        URL.revokeObjectURL(draft.files[index].url);
        draft.files.splice(index, 1);
        this._renderCompose();
      }),
    );
    this.querySelector("[data-save]")?.addEventListener(
      "click",
      () => void this._save(),
    );
  }
  _addFiles(files) {
    const selected = [...draft.files.map((entry) => entry.file), ...files];
    if (
      selected.length > MAX_CARE_PHOTOS ||
      selected.some(
        (file) =>
          !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
          !file.size ||
          file.size > 10 * 1024 * 1024,
      ) ||
      selected.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024
    ) {
      draft.error = t("care.photo.limit");
    } else {
      draft.error = "";
      draft.files.push(
        ...files.map((file) => ({
          file,
          url: URL.createObjectURL(file),
          reservation: null,
          uploaded: false,
        })),
      );
    }
    this._renderCompose();
  }
  async _save() {
    if (this._busy || (draft.kind === "other" && !draft.note.trim())) return;
    this._busy = true;
    draft.error = "";
    this._controller = new AbortController();
    this._renderCompose();
    const saving = draft;
    try {
      for (const entry of saving.files) {
        if (entry.uploaded) continue;
        entry.reservation = await presignCarePhoto(saving.workId, {
          ...(entry.reservation ? { photoId: entry.reservation.photoId } : {}),
          contentType: entry.file.type,
          contentLength: entry.file.size,
        });
        if (!this.isConnected) return;
        try {
          await putMediaWithProgress(
            entry.reservation.uploadUrl,
            entry.file,
            entry.reservation.uploadHeaders,
            (progress) => {
              const status = this.querySelector("[data-progress]");
              if (status)
                status.textContent = t("care.uploading", { progress });
            },
            this._controller.signal,
          );
        } catch (error) {
          // Conditional PUT replay means the previous uncertain upload landed.
          if (error?.status !== 412) throw error;
        }
        entry.uploaded = true;
      }
      // Once submission may have reached the server, retries keep exactly the
      // same payload and ID instead of turning a lost response into an edit.
      saving.payload ||= {
        workId: saving.workId,
        kind: saving.kind,
        note: saving.note,
        photoIds: saving.files.map((entry) => entry.reservation.photoId),
      };
      const result = await createCareWork(saving.payload);
      if (!this.isConnected) return;
      lastSaved = { siteId: this._siteId, work: result.work };
      const returnToList = saving.returnToList;
      clearDraft();
      this._busy = false;
      showToast({ title: t("care.success"), message: "", icon: "check" });
      if (returnToList) returnToList();
      else replaceRoute("/care-work");
    } catch (error) {
      if (!this.isConnected) return;
      // A validation rejection definitively did not create a log. Let the
      // user remove a corrupt photo or correct the input; only uncertain
      // network/server failures must keep the exact submission frozen.
      if ([400, 422].includes(error?.status)) saving.payload = null;
      saving.error = t("care.saveError");
      this._busy = false;
      this._renderCompose();
    }
  }
  async _loadDetail(workId) {
    try {
      const { work } = await getCareWork(workId);
      work.photos = await Promise.all(
        work.photos.map(async (photo) => {
          if (photo.expiresAt <= Date.now() / 1000) return photo;
          try {
            return {
              ...photo,
              url: (await getCarePhoto(workId, photo.photoId)).downloadUrl,
            };
          } catch (error) {
            return { ...photo, unavailable: error?.status !== 410 };
          }
        }),
      );
      if (!this.isConnected) return;
      this.innerHTML = careDetail(work);
      this._bindBack("/care-work");
      this.querySelectorAll(".care-detail-photos img").forEach((image) =>
        image.addEventListener("error", () => {
          image.closest("button")?.remove();
          if (!this.querySelector(".care-photo-unavailable")) {
            const message = document.createElement("p");
            message.className = "care-photo-unavailable";
            message.textContent = t("care.photo.unavailable");
            this.append(message);
          }
        }),
      );
    } catch {
      if (this.isConnected) this._loadError(() => this._loadDetail(workId));
    }
  }
}
customElements.define("care-work-view", CareWorkView);
