// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  perimeter-check — 5c capture (MVP native-camera port). Walk the four sides
  (numbered "Side N of 4"); cover each with one or more photos, or Skip a side.
  Cancel leaves the walk but keeps the draft (resume from home). After the last
  side, submit runs the (mock) analyzer and hands off to 5e.

  Capture is a native camera handoff: the ＋ "Add photo" tile clicks a hidden
  <input type="file" accept="image/*" capture="environment">, so users get their
  device's full camera (zoom / focus / flash / lens). On desktop the same input is
  a file picker. The returned file is read to a JPEG data-URL, which serializes
  straight into the IndexedDB draft and matches the analyzer's base64 flow.
  Photo-only by design — voice/note capture is deferred post-MVP (its plumbing is
  left intact but unused).
*/
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { submitCheck, submitErrorMessage } from "../services/submit-check.js";
import { isBrowserCameraEnabled } from "../services/capture-mode.js";
// <in-browser-camera> registers itself via main.js (opt-in ?webcam feature).
import {
  ensureCheck,
  startCheck,
  loadDraft,
  getSideOrder,
  getCurrentCheck,
  getFlowType,
  getActiveSideIndex,
  setActiveSideIndex,
  consumePostDescribeAction,
  addItem,
  removeItem,
  setSideDescription,
  skipSide,
  isSideCovered,
  isCurrentSession,
} from "../state/check-session.js";
import {
  shell,
  shellWebcam,
  segment,
  shotTile,
  descriptionTile,
  addTile,
} from "./perimeter-check.templates.js";

class PerimeterCheck extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    // Resume a persisted draft if one exists; else start fresh.
    const check = getCurrentCheck() || (await loadDraft("perimeter")) || null;
    if (!check) {
      ensureCheck(this._siteId);
    } else if (getFlowType() !== "perimeter") {
      startCheck(this._siteId);
    }
    this._checkId = getCurrentCheck()?.id || "";
    this._sides = getSideOrder();

    const activeSideIndex = getActiveSideIndex();
    const hasActiveSide =
      activeSideIndex >= 0 && activeSideIndex < this._sides.length;
    const postDescribeAction = consumePostDescribeAction();
    // Resume at the explicitly active side when returning from /check/describe.
    // Otherwise start at the first side that still needs attention.
    if (postDescribeAction?.type === "stay") {
      this._sideIndex = postDescribeAction.sideIndex;
    } else if (postDescribeAction?.type === "advance") {
      this._sideIndex = postDescribeAction.sideIndex;
    } else if (postDescribeAction?.type === "submit") {
      this._sideIndex = this._sides.length - 1;
      this._pendingSubmit = true;
    } else if (hasActiveSide && !isSideCovered(this._sides[activeSideIndex])) {
      this._sideIndex = activeSideIndex;
    } else {
      const firstOpen = this._sides.findIndex((s) => !isSideCovered(s));
      this._sideIndex = firstOpen === -1 ? 0 : firstOpen;
    }

    // Opt-in inline browser camera (?webcam, persisted). Falls back to native on
    // an unavailable/denied camera (see _onCameraUnavailable).
    this._webcam = isBrowserCameraEnabled();
    this._webcamFailed = false;

    this.innerHTML = this._webcam ? shellWebcam() : shell();
    this._fileInput = this.querySelector("#file-input");

    this.querySelector("#cancel").addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#skip-side").addEventListener("click", () =>
      this._skip(),
    );
    this.querySelector("#previous-side").addEventListener("click", () =>
      this._back(),
    );
    this.querySelector("#next-side").addEventListener("click", () =>
      this._forward(),
    );
    this.querySelector("#describe-instead").addEventListener("click", () =>
      this._describeInstead(),
    );
    // The ＋ tile and per-shot delete are re-rendered each change, so delegate.
    this.querySelector("#shotgrid").addEventListener("click", (e) =>
      this._onGridClick(e),
    );
    // A photo came back from the file picker (native path + webcam fallback).
    this._fileInput.addEventListener("change", () => this._onFilePicked());

    if (this._webcam) this._mountCamera();

    this._renderSide();
    if (this._pendingSubmit) {
      this._pendingSubmit = false;
      queueMicrotask(() => this._submit());
    }
  }

  _useWebcam() {
    return this._webcam && !this._webcamFailed;
  }

  /* ---- inline browser camera (opt-in; isolated for easy removal) ---- */
  // Mounted once and kept alive across captures and sides; capture events add a
  // photo to the current side. On unavailable/denied, revert to the native tile.
  _mountCamera() {
    const panel = this.querySelector("#camera-panel");
    if (!panel) return;
    this._camera = document.createElement("in-browser-camera");
    this._camera.addEventListener("capture", (e) =>
      this._addPhoto(this._side, e.detail.dataUrl),
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
    // With the camera gone, _renderShots restores the ＋ "Add photo" tile.
    this._renderShots();
  }

  get _side() {
    return this._sides[this._sideIndex];
  }
  get _isLast() {
    return this._sideIndex === this._sides.length - 1;
  }
  _sideState() {
    return getCurrentCheck().sides[this._side];
  }

  /* ---- capture (native handoff) ---- */
  // The ＋ "Add photo" tile opens the device camera (phone) / file picker (desktop).
  // In webcam mode the inline camera replaces this tile; the tile only reappears on
  // the denied-camera fallback, which routes back here.
  _openCamera() {
    this._fileInput.value = ""; // allow re-picking the same file
    this._fileInput.click();
  }

  _onFilePicked() {
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
    const originCheckId = this._checkId;
    const originSide = this._side;
    const reader = new FileReader();
    this._fileReader = reader;
    reader.onload = () => {
      if (!this.isConnected || !isCurrentSession(originCheckId, "perimeter")) {
        this._fileReader = null;
        return;
      }
      this._fileReader = null;
      this._addPhoto(originSide, reader.result);
    };
    reader.onerror = () => {
      this._fileReader = null;
    };
    reader.onabort = () => {
      this._fileReader = null;
    };
    reader.readAsDataURL(file);
  }

  _addPhoto(side, dataUrl) {
    addItem(side, { kind: "photo", dataUrl });
    this._renderSegments();
    this._renderShots();
    this._syncControls();
  }

  disconnectedCallback() {
    if (this._fileReader?.readyState === FileReader.LOADING) {
      this._fileReader.abort();
    }
  }

  /* ---- grid interactions (add + delete, delegated) ---- */
  _onGridClick(e) {
    if (e.target.closest("#add-photo")) {
      this._openCamera();
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      removeItem(this._side, del.getAttribute("data-del"));
      this._renderSegments();
      this._renderShots();
      this._syncControls();
      return;
    }
    if (e.target.closest("[data-del-description]")) {
      setSideDescription(this._side, null);
      this._renderSegments();
      this._renderShots();
      this._syncControls();
      return;
    }
    if (e.target.closest("[data-edit-description]")) {
      this._describeInstead();
    }
  }

  /* ---- navigation ---- */
  _skip() {
    skipSide(this._side);
    this._afterSide();
  }

  _forward() {
    // Enabled only once the side has a photo (Skip covers the no-photo path).
    this._afterSide();
  }

  /** @returns {void} */
  _back() {
    if (this._sideIndex === 0) return;
    this._sideIndex -= 1;
    setActiveSideIndex(this._sideIndex);
    this._renderSide();
    window.scrollTo?.({ top: 0 });
  }

  _describeInstead() {
    setActiveSideIndex(this._sideIndex);
    navigate("/check/describe");
  }

  // Advance to the next side, or submit after the last.
  _afterSide() {
    if (this._isLast) {
      this._submit();
      return;
    }
    this._sideIndex += 1;
    setActiveSideIndex(this._sideIndex);
    this._renderSide();
    window.scrollTo?.({ top: 0 });
  }

  async _submit() {
    // Release the camera before the summarising overlay covers the screen.
    if (this._camera) {
      this._camera.remove();
      this._camera = null;
    }
    const overlay = this.querySelector("#summarising");
    overlay.hidden = false;
    try {
      await submitCheck({ submissionKind: "check" });
      navigate("/today");
    } catch (err) {
      // Online-only: on any backend/network failure hide the summarising overlay
      // and surface a retryable error (no local queue — offline is post-MVP).
      console.error("submitCheck failed", err);
      overlay.hidden = true;
      // We tore the camera down before submitting; remount it so webcam-mode users
      // can still add photos on this (or another) side before retrying. (Native and
      // fallback modes keep their ＋ tile, so nothing to restore there.)
      if (this._useWebcam() && !this._camera) this._mountCamera();
      this._showSubmitError(err);
    }
  }

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

  _cancel() {
    // Draft is already persisted — leaving keeps it for resume from home.
    navigate("/today");
  }

  /* ---- render ---- */
  _renderSide() {
    setActiveSideIndex(this._sideIndex);
    this.querySelector("#side-progress").textContent =
      `Side ${this._sideIndex + 1} of ${this._sides.length}`;
    this._renderSegments();
    this._renderShots();
    this._syncControls();
  }

  _renderSegments() {
    const check = getCurrentCheck();
    this.querySelector("#segbar").innerHTML = this._sides
      .map((side, index) => {
        const s = check.sides[side];
        let state;
        if (index === this._sideIndex) state = "current";
        else if (s.items.length) state = "captured";
        else if (s.skipped) state = "skipped";
        else state = "pending";
        return segment({ index, state });
      })
      .join("");
  }

  // This side's shots as an inline grid. Native path (and webcam fallback) appends
  // the ＋ "Add photo" tile; with the inline camera live, thumbnails render alone.
  _renderShots() {
    const sideState = this._sideState();
    const items = sideState.items;
    const grid = this.querySelector("#shotgrid");
    const hasDescription = Boolean(sideState.description?.validated);
    grid.classList.toggle(
      "shotgrid--empty",
      items.length === 0 && !hasDescription,
    );
    const tile = this._useWebcam()
      ? ""
      : addTile(items.length === 0 && !hasDescription);
    const description = hasDescription
      ? descriptionTile({
          side: this._side,
        })
      : "";
    grid.innerHTML = items.map(shotTile).join("") + description + tile;
  }

  _syncControls() {
    const side = this._sides[this._sideIndex];
    const canAdvanceOrSubmit = isSideCovered(side);
    const previous = this.querySelector("#previous-side");
    previous.disabled = this._sideIndex === 0;
    const next = this.querySelector("#next-side");
    next.disabled = !canAdvanceOrSubmit;
    next.textContent = this._isLast ? "Submit check" : "Next side ›";
  }
}

customElements.define("perimeter-check", PerimeterCheck);
