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
import { submitCheck } from "../services/submit-check.js";
import {
  SIDES,
  ensureCheck,
  loadDraft,
  getCurrentCheck,
  getActiveSideIndex,
  setActiveSideIndex,
  addItem,
  removeItem,
  skipSide,
  isSideCovered,
} from "../state/check-session.js";
import {
  shell,
  segment,
  shotTile,
  addTile,
} from "./perimeter-check.templates.js";

class PerimeterCheck extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id;
    // Resume a persisted draft if one exists; else start fresh.
    const check = getCurrentCheck() || (await loadDraft()) || null;
    if (!check) ensureCheck(this._siteId);

    const activeSideIndex = getActiveSideIndex();
    const hasActiveSide = activeSideIndex >= 0 && activeSideIndex < SIDES.length;
    // Resume at the explicitly active side when returning from /check/describe.
    // Otherwise start at the first side that still needs attention.
    if (hasActiveSide) {
      this._sideIndex = activeSideIndex;
    } else {
      const firstOpen = SIDES.findIndex((s) => !isSideCovered(s));
      this._sideIndex = firstOpen === -1 ? 0 : firstOpen;
    }

    this.innerHTML = shell();
    this._fileInput = this.querySelector("#file-input");

    this.querySelector("#cancel").addEventListener("click", () =>
      this._cancel(),
    );
    this.querySelector("#skip-side").addEventListener("click", () =>
      this._skip(),
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
    // A photo came back from the camera / file picker.
    this._fileInput.addEventListener("change", () => this._onFilePicked());

    this._renderSide();
  }

  get _side() {
    return SIDES[this._sideIndex];
  }
  get _isLast() {
    return this._sideIndex === SIDES.length - 1;
  }
  _sideState() {
    return getCurrentCheck().sides[this._side];
  }

  /* ---- capture (native handoff) ---- */
  // Open the device camera (phone) / file picker (desktop).
  _openCamera() {
    this._fileInput.value = ""; // allow re-picking the same file
    this._fileInput.click();
  }

  _onFilePicked() {
    const file = this._fileInput.files && this._fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      addItem(this._side, { kind: "photo", dataUrl: reader.result });
      this._renderSegments();
      this._renderShots();
      this._syncControls();
    };
    reader.readAsDataURL(file);
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
    const overlay = this.querySelector("#summarising");
    overlay.hidden = false;
    try {
      await submitCheck();
      navigate("/results");
    } catch (err) {
      // Online-only: on any backend/network failure hide the summarising overlay
      // and surface a retryable error (no local queue — offline is post-MVP).
      console.error("submitCheck failed", err);
      overlay.hidden = true;
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
      "Couldn’t file this check — the server didn’t respond. Try again.";
  }

  _cancel() {
    // Draft is already persisted — leaving keeps it for resume from home.
    navigate("/today");
  }

  /* ---- render ---- */
  _renderSide() {
    setActiveSideIndex(this._sideIndex);
    this.querySelector("#side-progress").textContent =
      `Side ${this._sideIndex + 1} of ${SIDES.length}`;
    this._renderSegments();
    this._renderShots();
    this._syncControls();
  }

  _renderSegments() {
    const check = getCurrentCheck();
    this.querySelector("#segbar").innerHTML = SIDES.map((side, index) => {
      const s = check.sides[side];
      let state;
      if (index === this._sideIndex) state = "current";
      else if (s.items.length) state = "captured";
      else if (s.skipped) state = "skipped";
      else state = "pending";
      return segment({ index, state });
    }).join("");
  }

  // This side's shots as an inline grid, followed by the ＋ "Add photo" tile.
  // Empty side → the tile stands alone (larger, with a hint).
  _renderShots() {
    const items = this._sideState().items;
    const grid = this.querySelector("#shotgrid");
    grid.classList.toggle("shotgrid--empty", items.length === 0);
    grid.innerHTML = items.map(shotTile).join("") + addTile(items.length === 0);
  }

  _syncControls() {
    const hasPhoto = this._sideState().items.length > 0;
    const next = this.querySelector("#next-side");
    next.disabled = !hasPhoto;
    next.textContent = this._isLast ? "Submit check" : "Next side ›";
  }
}

customElements.define("perimeter-check", PerimeterCheck);
