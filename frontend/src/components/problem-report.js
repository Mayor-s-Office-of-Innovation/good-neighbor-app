/*
  problem-report — a single-problem capture flow. Same capture/describe/submit
  architecture as perimeter-check, but scoped to one report instead of multiple
  sides. Submit runs the existing backend analysis path and lands on the same
  review/results screen as perimeter checks.
*/
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { submitCheck } from "../services/submit-check.js";
import { isBrowserCameraEnabled } from "../services/capture-mode.js";
import {
  ensureProblemReport,
  startProblemReport,
  loadDraft,
  clearCheck,
  getCurrentCheck,
  getSideOrder,
  setActiveSideIndex,
  addItem,
  removeItem,
  isSideCovered,
  getFlowType,
  isCurrentSession,
} from "../state/check-session.js";
import { shell, shellWebcam } from "./problem-report.templates.js";
import { shotTile, addTile } from "./perimeter-check.templates.js";

/**
 * @typedef {{ siteId?: string, providerSiteId?: string, id?: string, name?: string }} SiteRecord
 * @typedef {{ kind: "photo", dataUrl: string }} PhotoItemInput
 * @typedef {{ id?: string | null, detail?: { dataUrl?: string } }} CameraCaptureEvent
 * @typedef {{ id?: string | null }} CameraUnavailableEvent
 * @typedef {{ items: Array<{ id: string, dataUrl: string, side?: string }> }} SideState
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
    this._side = "";
    /** @type {boolean} */
    this._webcam = false;
    /** @type {boolean} */
    this._webcamFailed = false;
    /** @type {HTMLInputElement | null} */
    this._fileInput = null;
    /** @type {FileReader | null} */
    this._fileReader = null;
    /** @type {HTMLElement | null} */
    this._camera = null;
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

    this._side = getSideOrder()[0];
    setActiveSideIndex(0);

    this._webcam = isBrowserCameraEnabled();
    this._webcamFailed = false;

    this.innerHTML = this._webcam ? shellWebcam() : shell();
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

    if (this._webcam) this._mountCamera();

    this._renderShots();
    this._syncControls();
  }

  /** @returns {boolean} */
  _useWebcam() {
    return this._webcam && !this._webcamFailed;
  }

  /** @returns {SideState} */
  _sideState() {
    const check = getCurrentCheck();
    return /** @type {SideState} */ (
      check?.sides?.[this._side] || { items: [] }
    );
  }

  /** @returns {void} */
  _mountCamera() {
    const panel = this.querySelector("#camera-panel");
    if (!panel) return;
    this._camera = /** @type {HTMLElement} */ (
      document.createElement("in-browser-camera")
    );
    this._camera.addEventListener("capture", (event) => {
      const e = /** @type {CustomEvent<{ dataUrl?: string }>} */ (event);
      if (e.detail?.dataUrl) this._addPhoto(e.detail.dataUrl);
    });
    this._camera.addEventListener("unavailable", () =>
      this._onCameraUnavailable(),
    );
    panel.appendChild(this._camera);
  }

  /** @returns {void} */
  _onCameraUnavailable() {
    this._webcamFailed = true;
    if (this._camera) {
      this._camera.remove();
      this._camera = null;
    }
    this._renderShots();
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
    addItem(
      this._side,
      /** @type {PhotoItemInput} */ ({ kind: "photo", dataUrl }),
    );
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
      removeItem(this._side, del.getAttribute("data-del"));
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
    const items = this._sideState().items;
    const grid = this.querySelector("#shotgrid");
    if (!grid) return;
    grid.classList.toggle("shotgrid--empty", items.length === 0);
    const tile = this._useWebcam() ? "" : addTile(items.length === 0);
    grid.innerHTML =
      items.map((item, index) => shotTile(item, index)).join("") + tile;
  }

  /** @returns {void} */
  _syncControls() {
    const submit = this.querySelector("#submit-report");
    if (!(submit instanceof HTMLButtonElement)) return;
    submit.disabled = !isSideCovered(this._side);
  }

  /** @returns {Promise<void>} */
  async _submit() {
    if (!isSideCovered(this._side)) return;
    if (this._camera) {
      this._camera.remove();
      this._camera = null;
    }
    const overlay = /** @type {HTMLElement | null} */ (
      this.querySelector("#summarising")
    );
    if (!overlay) return;
    overlay.hidden = false;
    try {
      await submitCheck({ submissionKind: "problem_report" });
      navigate("/today");
    } catch (err) {
      console.error("submitCheck failed", err);
      overlay.hidden = true;
      if (this._useWebcam() && !this._camera) this._mountCamera();
      this._showSubmitError();
    }
  }

  /** @returns {void} */
  _showSubmitError() {
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
    el.textContent =
      "Couldn’t file this report — the server didn’t respond. Try again.";
  }

  /** @returns {void} */
  disconnectedCallback() {
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
  }
}

customElements.define("problem-report", ProblemReport);
