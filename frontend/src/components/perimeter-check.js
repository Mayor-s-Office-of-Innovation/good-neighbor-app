// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  perimeter-check — 5c capture (design port, screen 14). Walk the four sides
  (N/E/S/W); cover each with any mix of photo / voice / note, or mark a side
  "can't cover" (sticky N/A). Captures upload immediately and analysis is sealed
  until submit — no findings shown here.

  The design's Voice / Photo / Note tiles are plain buttons that DRIVE the hidden
  <capture-photo>/<capture-audio> controllers (mounted once so an in-progress
  recording or picked photo is never nuked). Only the stepper + item list
  re-render on change.
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
import { shell, itemRow, step } from "./perimeter-check.templates.js";

const GUIDANCE = {
  North: "Curb to building line. Include the gutter and any doorway.",
  East: "Curb to building line. Include the gutter and doorway.",
  South: "Curb to building line. Include the tree well and doorway.",
  West: "Curb to building line. Note any construction fencing.",
};
const FRONTAGE = {
  North: "North frontage",
  East: "Mission St frontage",
  South: "South frontage",
  West: "West frontage",
};

class PerimeterCheck extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._siteId = this._site.siteId || this._site.id;
    const check = ensureCheck(this._siteId);
    this._sideIndex = 0;
    this._recording = false;

    this.innerHTML = shell({
      siteName: this._site.name,
      started: timeOf(check.startedAt),
    });
    this._photo = this.querySelector("capture-photo");
    this._audio = this.querySelector("capture-audio");
    this._note = this.querySelector("#note-input");
    this._composer = this.querySelector("#note-composer");

    // Trio tiles proxy to the hidden capture controllers.
    this.querySelector("#photo-tile").addEventListener("click", () =>
      this._photo.querySelector("#photo-input").click(),
    );
    this.querySelector("#voice-tile").addEventListener("click", () =>
      this._toggleVoice(),
    );
    this.querySelector("#note-tile").addEventListener("click", () =>
      this._toggleComposer(),
    );

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
    this.querySelector("#back").addEventListener("click", () =>
      navigate("/today"),
    );
    this.querySelector("#item-list").addEventListener("click", (e) =>
      this._onItemClick(e),
    );

    this._renderSide();
  }

  get _side() {
    return SIDES[this._sideIndex];
  }

  _toggleComposer() {
    const open = this._composer.hidden;
    this._composer.hidden = !open;
    if (open) this._note.focus?.();
  }

  // Proxy a click to the hidden recorder's own toggle button; reflect state on
  // the Voice tile. The recorder fires "change" on stop -> _onAudio finalizes.
  _toggleVoice() {
    this._audio.querySelector("#rec-btn")?.click();
    this._recording = !this._recording;
    const tile = this.querySelector("#voice-tile");
    tile.classList.toggle("is-recording", this._recording);
    this.querySelector("#voice-label").textContent = this._recording
      ? "Stop"
      : "Voice";
  }

  _onPhoto() {
    const f = this._photo.file;
    if (!f) return;
    const thumbUrl = URL.createObjectURL(f);
    addItem(this._side, { kind: "photo", size: f.size, thumbUrl });
    this._photo.reset();
    this._renderItems();
    this._renderStepper();
  }

  async _onAudio() {
    const blob = this._audio.blob;
    // Reset the Voice tile regardless (recording just ended).
    this._recording = false;
    this.querySelector("#voice-tile").classList.remove("is-recording");
    this.querySelector("#voice-label").textContent = "Voice";
    if (!blob) return;
    const item = addItem(this._side, { kind: "voice", size: blob.size });
    this._audio.reset();
    this._renderItems();
    this._renderStepper();
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
    this._composer.hidden = true;
    this._renderItems();
    this._renderStepper();
  }

  _onItemClick(e) {
    const btn = e.target.closest("[data-remove]");
    if (!btn) return;
    removeItem(this._side, btn.getAttribute("data-remove"));
    this._renderItems();
    this._renderStepper();
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
    this._composer.hidden = true;

    // Next applicable side after the current one; if none remain, go to review.
    for (let i = this._sideIndex + 1; i < SIDES.length; i++) {
      if (getCurrentCheck().sides[SIDES[i]].applicable) {
        this._sideIndex = i;
        this._renderSide();
        this.scrollTo?.({ top: 0 });
        window.scrollTo?.({ top: 0 });
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
    this.querySelector("#side-title").textContent =
      `${this._side} side · ${FRONTAGE[this._side]}`;
    this.querySelector("#side-guidance").textContent =
      GUIDANCE[this._side] || "";

    const isLast = applicable.indexOf(this._side) === applicable.length - 1;
    const nextSide = isLast
      ? null
      : applicable[applicable.indexOf(this._side) + 1];
    this.querySelector("#next-side").textContent = isLast
      ? "Review & submit"
      : `Next side · ${nextSide}`;

    this._renderStepper();
    this._renderItems();
  }

  _renderStepper() {
    const check = getCurrentCheck();
    this.querySelector("#stepper").innerHTML = SIDES.map((side) =>
      step({
        side,
        current: side === this._side,
        applicable: check.sides[side].applicable,
        items: check.sides[side].items,
      }),
    ).join("");
  }

  _renderItems() {
    const items = getCurrentCheck().sides[this._side].items;
    this.querySelector("#item-count").textContent =
      `${items.length} item${items.length === 1 ? "" : "s"}`;
    this.querySelector("#item-list").innerHTML = items.map(itemRow).join("");
    // Upload/analysis reassurance appears once the side has evidence. The live
    // percentage is representative — in this build captures upload instantly.
    this.querySelector("#uploadbar").hidden = items.length === 0;
  }
}
function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

customElements.define("perimeter-check", PerimeterCheck);
