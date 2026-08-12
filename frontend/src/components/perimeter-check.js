// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  perimeter-check — 5c capture. Walk the four sides (N/E/S/W); cover each with any
  mix of photo / voice / note (reusing the existing <capture-photo>/<capture-audio>
  plumbing), or mark a side "can't cover" (sticky N/A). Captures upload immediately
  (decision) and analysis is sealed until submit — no findings shown here.

  Rendering: the shell + capture controls mount ONCE; only the side rail and item
  list re-render on change, so an in-progress recording or picked photo is never
  nuked by a state update.
*/
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { transcribe } from "../services/transcribe.js";
import {
  SIDES,
  ensureCheck,
  getCurrentCheck,
  addItem,
  removeItem,
  setSideApplicable,
  applicableSides,
} from "../state/check-session.js";
import { shell, itemRow, railItem } from "./perimeter-check.templates.js";

const GUIDANCE = {
  North: "Curb to building line. Include the gutter and any doorway.",
  East: "Mission St frontage — curb to building line. Get the gutter and doorway.",
  South: "Curb to building line. Include the tree well and doorway.",
  West: "Curb to building line. Note any construction fencing.",
};

class PerimeterCheck extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    ensureCheck(this._site.id);
    this._sideIndex = 0;

    this.innerHTML = shell({ siteName: this._site.name });
    this._photo = this.querySelector("capture-photo");
    this._audio = this.querySelector("capture-audio");
    this._note = this.querySelector("#note-input");

    this._photo.addEventListener("change", () => this._onPhoto());
    this._audio.addEventListener("change", () => this._onAudio());
    this.querySelector("#add-note").addEventListener("click", () =>
      this._onNote(),
    );
    this.querySelector("#na-side").addEventListener("click", () =>
      this._onNoCover(),
    );
    this.querySelector("#next-side").addEventListener("click", () =>
      this._onNext(),
    );
    this.querySelector("#item-list").addEventListener("click", (e) =>
      this._onItemClick(e),
    );

    this._renderSide();
  }

  get _side() {
    return SIDES[this._sideIndex];
  }

  _onPhoto() {
    const f = this._photo.file;
    if (!f) return;
    const thumbUrl = URL.createObjectURL(f);
    addItem(this._side, { kind: "photo", size: f.size, thumbUrl });
    this._photo.reset();
    this._renderItems();
    this._renderRail();
  }

  async _onAudio() {
    const blob = this._audio.blob;
    if (!blob) return;
    const item = addItem(this._side, { kind: "voice", size: blob.size });
    this._audio.reset();
    this._renderItems();
    this._renderRail();
    // Mock transcription resolves shortly; patch the item + re-render in place.
    const text = await transcribe(blob);
    item.transcript = text;
    this._renderItems();
  }

  _onNote() {
    const text = (this._note.value || "").trim();
    if (!text) return;
    addItem(this._side, { kind: "note", text });
    this._note.value = "";
    this._renderItems();
    this._renderRail();
  }

  _onItemClick(e) {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    removeItem(this._side, btn.getAttribute("data-remove"));
    this._renderItems();
    this._renderRail();
  }

  _onNoCover() {
    setSideApplicable(this._side, false);
    this._advance();
  }

  _onNext() {
    this._advance();
  }

  _advance() {
    // Reset per-side capture controls before moving on.
    this._photo.reset();
    this._audio.reset();
    this._note.value = "";

    // Next applicable side after the current one; if none remain, go to review.
    for (let i = this._sideIndex + 1; i < SIDES.length; i++) {
      if (getCurrentCheck().sides[SIDES[i]].applicable) {
        this._sideIndex = i;
        this._renderSide();
        this.scrollTo({ top: 0 });
        return;
      }
    }
    navigate("/review");
  }

  _renderSide() {
    const applicable = applicableSides();
    const stepNum = applicable.indexOf(this._side) + 1;
    this.querySelector("#side-progress").textContent =
      `Side ${stepNum} of ${applicable.length}`;
    this.querySelector("#side-title").textContent = `${this._side} side`;
    this.querySelector("#side-guidance").textContent =
      GUIDANCE[this._side] || "";

    const isLast =
      this._sideIndex === SIDES.length - 1 ||
      applicable.indexOf(this._side) === applicable.length - 1;
    this.querySelector("#next-side").textContent = isLast
      ? "Review & submit"
      : `Next side`;

    this._renderRail();
    this._renderItems();
  }

  _renderRail() {
    const check = getCurrentCheck();
    this.querySelector("#side-rail").innerHTML = SIDES.map((side) =>
      railItem({
        side,
        current: side === this._side,
        applicable: check.sides[side].applicable,
        count: check.sides[side].items.length,
      }),
    ).join("");
  }

  _renderItems() {
    const items = getCurrentCheck().sides[this._side].items;
    this.querySelector("#item-count").textContent =
      `${items.length} item${items.length === 1 ? "" : "s"}`;
    this.querySelector("#item-list").innerHTML = items.map(itemRow).join("");
  }
}
customElements.define("perimeter-check", PerimeterCheck);
