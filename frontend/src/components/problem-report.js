// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
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
  getCurrentCheck,
  getSideOrder,
  setActiveSideIndex,
  addItem,
  removeItem,
  isSideCovered,
  getFlowType,
} from "../state/check-session.js";
import { shell, shellWebcam } from "./problem-report.templates.js";
import { shotTile, addTile } from "./perimeter-check.templates.js";

class ProblemReport extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;

    const check = getCurrentCheck() || (await loadDraft()) || null;
    if (!check) {
      ensureProblemReport(this._siteId);
    } else if (getFlowType() !== "single-problem") {
      startProblemReport(this._siteId);
    }

    this._side = getSideOrder()[0];
    setActiveSideIndex(0);

    this._webcam = isBrowserCameraEnabled();
    this._webcamFailed = false;

    this.innerHTML = this._webcam ? shellWebcam() : shell();
    this._fileInput = this.querySelector("#file-input");

    this.querySelector("#cancel").addEventListener("click", () => this._cancel());
    this.querySelector("#describe-instead").addEventListener("click", () =>
      this._describeInstead(),
    );
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

  _useWebcam() {
    return this._webcam && !this._webcamFailed;
  }

  _sideState() {
    return getCurrentCheck().sides[this._side];
  }

  _mountCamera() {
    const panel = this.querySelector("#camera-panel");
    if (!panel) return;
    this._camera = document.createElement("in-browser-camera");
    this._camera.addEventListener("capture", (e) =>
      this._addPhoto(e.detail.dataUrl),
    );
    this._camera.addEventListener("unavailable", () =>
      this._onCameraUnavailable(),
    );
    panel.appendChild(this._camera);
  }

  _onCameraUnavailable() {
    this._webcamFailed = true;
    if (this._camera) {
      this._camera.remove();
      this._camera = null;
    }
    this._renderShots();
  }

  _openCamera() {
    this._fileInput.value = "";
    this._fileInput.click();
  }

  _onFilePicked() {
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this._addPhoto(reader.result);
    reader.readAsDataURL(file);
  }

  _addPhoto(dataUrl) {
    addItem(this._side, { kind: "photo", dataUrl });
    this._renderShots();
    this._syncControls();
  }

  _onGridClick(e) {
    if (e.target.closest("#add-photo")) {
      this._openCamera();
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      removeItem(this._side, del.getAttribute("data-del"));
      this._renderShots();
      this._syncControls();
    }
  }

  _cancel() {
    navigate("/today");
  }

  _describeInstead() {
    navigate("/problem/describe");
  }

  _renderShots() {
    const items = this._sideState().items;
    const grid = this.querySelector("#shotgrid");
    grid.classList.toggle("shotgrid--empty", items.length === 0);
    const tile = this._useWebcam() ? "" : addTile(items.length === 0);
    grid.innerHTML = items.map(shotTile).join("") + tile;
  }

  _syncControls() {
    const submit = this.querySelector("#submit-report");
    submit.disabled = !isSideCovered(this._side);
  }

  async _submit() {
    if (!isSideCovered(this._side)) return;
    if (this._camera) {
      this._camera.remove();
      this._camera = null;
    }
    const overlay = this.querySelector("#summarising");
    overlay.hidden = false;
    try {
      await submitCheck();
      navigate("/results");
    } catch (err) {
      console.error("submitCheck failed", err);
      overlay.hidden = true;
      if (this._useWebcam() && !this._camera) this._mountCamera();
      this._showSubmitError();
    }
  }

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
}

customElements.define("problem-report", ProblemReport);
