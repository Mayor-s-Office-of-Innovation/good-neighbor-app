/*
  problem-report — a single-problem capture flow. Same capture/describe/submit
  architecture as perimeter-check, but scoped to one report instead of multiple
  places. Submit runs the existing backend analysis path and lands on the same
  review/results screen as perimeter checks.
*/
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { submitCheck, submitErrorMessage } from "../services/submit-check.js";
import {
  enqueueUpload,
  resumePendingUploads,
} from "../services/artifact-uploader.js";
import {
  ensureProblemReport,
  startProblemReport,
  loadDraft,
  clearCheck,
  getCurrentCheck,
  getPlaceOrder,
  setActivePlaceIndex,
  addItem,
  removeItem,
  isPlaceCovered,
  getFlowType,
  isCurrentSession,
} from "../state/check-session.js";
import { shell } from "./problem-report.templates.js";
import { shotTile, addTile } from "./perimeter-check.templates.js";

/**
 * @typedef {{ siteId?: string, providerSiteId?: string, id?: string, name?: string }} SiteRecord
 * @typedef {{ kind: "photo", dataUrl: string }} PhotoItemInput
 * @typedef {{ items: Array<{ id: string, dataUrl: string, placeId?: string, placeName?: string }> }} PlaceState
 */

class ProblemReport extends HTMLElement {
  constructor() {
    super();
    /** @type {SiteRecord | null} */
    this._site = null;
    /** @type {string} */
    this._siteId = "";
    /** @type {string} */
    this._checkId = "";
    /** @type {string} */
    this._placeId = "";
    /** @type {HTMLInputElement | null} */
    this._fileInput = null;
    /** @type {FileReader | null} */
    this._fileReader = null;
  }

  /** @returns {Promise<void>} */
  async connectedCallback() {
    /** @type {SiteRecord | null} */
    this._site = await getSite();
    this._siteId =
      this._site?.siteId || this._site?.providerSiteId || this._site?.id || "";

    const check =
      getCurrentCheck() || (await loadDraft("single-problem")) || null;
    if (!check) {
      ensureProblemReport(this._siteId);
    } else if (getFlowType() !== "single-problem") {
      startProblemReport(this._siteId);
    }
    this._checkId = getCurrentCheck()?.id || "";
    // Resume any photo upload interrupted by a reload / navigation mid-report.
    resumePendingUploads();

    this._placeId = getPlaceOrder()[0];
    setActivePlaceIndex(0);

    this.innerHTML = shell();
    this._fileInput = /** @type {HTMLInputElement | null} */ (
      this.querySelector("#file-input")
    );
    if (!this._fileInput) return;

    this.querySelector("#cancel").addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#describe-instead").addEventListener("click", () =>
      this._describeInstead(),
    );
    this._cancelDialog = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#cancel-report-dialog")
    );
    this.querySelector("#cancel-report-save")?.addEventListener("click", () => {
      this._cancelDialog?.close();
      navigate("/today");
    });
    this.querySelector("#cancel-report-discard")?.addEventListener(
      "click",
      () => {
        clearCheck();
        this._cancelDialog?.close();
        navigate("/today");
      },
    );
    this._cancelDialog?.addEventListener("click", (e) => {
      if (e.target === this._cancelDialog) this._cancelDialog.close();
    });
    this.querySelector("#submit-report").addEventListener("click", () =>
      this._submit(),
    );
    this.querySelector("#shotgrid").addEventListener("click", (e) =>
      this._onGridClick(e),
    );
    this._fileInput.addEventListener("change", () => this._onFilePicked());

    this._renderShots();
    this._syncControls();
  }

  /** @returns {PlaceState} */
  _placeState() {
    const check = getCurrentCheck();
    return /** @type {PlaceState} */ (
      check?.places?.[this._placeId] || { items: [] }
    );
  }

  /** @returns {void} */
  _openCamera() {
    if (!this._fileInput) return;
    this._fileInput.value = "";
    this._fileInput.click();
  }

  /** @returns {void} */
  _onFilePicked() {
    if (!this._fileInput) return;
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    const originCheckId = this._checkId;
    const reader = new FileReader();
    this._fileReader = reader;
    reader.onload = () => {
      if (
        !this.isConnected ||
        !isCurrentSession(originCheckId, "single-problem")
      ) {
        this._fileReader = null;
        return;
      }
      this._fileReader = null;
      if (typeof reader.result === "string") {
        this._addPhoto(reader.result);
      }
    };
    reader.onerror = () => {
      this._fileReader = null;
    };
    reader.onabort = () => {
      this._fileReader = null;
    };
    reader.readAsDataURL(file);
  }

  /** @param {string} dataUrl */
  _addPhoto(dataUrl) {
    const record = addItem(
      this._placeId,
      /** @type {PhotoItemInput} */ ({ kind: "photo", dataUrl }),
    );
    // Start pushing the bytes to S3 now, in the background, so by submit time
    // they're already up and submit only registers the metadata.
    if (record) enqueueUpload(getCurrentCheck()?.id, record.placeId, record.id);
    this._renderShots();
    this._syncControls();
  }

  /** @param {Event} e */
  _onGridClick(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest("#add-photo")) {
      this._openCamera();
      return;
    }
    const del = target.closest("[data-del]");
    if (del) {
      removeItem(this._placeId, del.getAttribute("data-del"));
      this._renderShots();
      this._syncControls();
    }
  }

  /** @returns {void} */
  _cancel() {
    this._cancelDialog?.showModal();
  }

  /** @returns {void} */
  _describeInstead() {
    navigate("/problem/describe");
  }

  /** @returns {void} */
  _renderShots() {
    const items = this._placeState().items;
    const grid = this.querySelector("#shotgrid");
    if (!grid) return;
    grid.classList.toggle("shotgrid--empty", items.length === 0);
    const tile = addTile(items.length === 0);
    grid.innerHTML =
      items.map((item, index) => shotTile(item, index)).join("") + tile;
  }

  /** @returns {void} */
  _syncControls() {
    const submit = this.querySelector("#submit-report");
    if (!(submit instanceof HTMLButtonElement)) return;
    submit.disabled = !isPlaceCovered(this._placeId);
  }

  /** @returns {Promise<void>} */
  async _submit() {
    if (!isPlaceCovered(this._placeId)) return;
    try {
      submitCheck({ submissionKind: "problem_report" });
      navigate("/today");
    } catch (err) {
      console.error("submitCheck failed", err);
      this._showSubmitError(err);
    }
  }

  /** @param {unknown} err @returns {void} */
  _showSubmitError(err) {
    let el = this.querySelector(".check__error");
    if (!el) {
      el = document.createElement("p");
      el.className = "check__error flow-error";
      el.setAttribute("role", "alert");
      this.querySelector(".check__actions")?.insertAdjacentElement(
        "afterend",
        el,
      );
    }
    el.textContent = submitErrorMessage(err);
  }

  /** @returns {void} */
  disconnectedCallback() {
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
  }
}

customElements.define("problem-report", ProblemReport);
