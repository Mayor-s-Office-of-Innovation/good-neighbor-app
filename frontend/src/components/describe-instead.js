// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
import { navigate } from "../router.js";
import {
  SIDES,
  getCurrentCheck,
  getActiveSideIndex,
  getSideDescription,
  setSideDescription,
} from "../state/check-session.js";
import { shell } from "./describe-instead.templates.js";

class DescribeInstead extends HTMLElement {
  connectedCallback() {
    const check = getCurrentCheck();
    if (!check) {
      navigate("/check");
      return;
    }

    this._sideIndex = getActiveSideIndex();
    this._side = SIDES[this._sideIndex] || SIDES[0];
    this._savedDescription = getSideDescription(this._side);
    this._savedText = this._savedDescription?.text || "";
    this._text = this._savedText;

    this._render();
    this._bind();
  }

  _bind() {
    this._field = this.querySelector("#describe-text");
    this._continue = this.querySelector("#describe-continue");
    this._dialog = this.querySelector("#describe-exit-modal");
    this._field.value = this._text;

    this.querySelector("#describe-close").addEventListener("click", () =>
      this._onClose(),
    );
    this.querySelector("#describe-dismiss").addEventListener("click", () =>
      this._onClose(),
    );
    this.querySelector("#describe-continue").addEventListener("click", () => this._onContinue());
    this.querySelector("#describe-discard").addEventListener("click", () =>
      this._discardAndExit(),
    );
    this._dialog.addEventListener("cancel", (event) => event.preventDefault());
    this._field.addEventListener("input", (event) => {
      this._text = event.target.value;
      this._continue.disabled = !this._text.trim();
      this._syncVoiceLabel();
    });

    this._field.focus();
    this._field.setSelectionRange(this._field.value.length, this._field.value.length);
  }

  _render() {
    this.innerHTML = shell({
      text: this._text,
      hasText: Boolean(this._text.trim()),
    });
  }

  _syncVoiceLabel() {
    const voice = this.querySelector("#describe-voice");
    if (!voice) return;
    voice.textContent = this._text.trim() ? "Add more by voice" : "Use voice";
  }

  _hasUnsavedChanges() {
    return this._text !== this._savedText;
  }

  _onClose() {
    if (!this._hasUnsavedChanges()) {
      navigate("/check");
      return;
    }
    this._dialog.showModal();
  }

  _discardAndExit() {
    this._dialog.close();
    navigate("/check");
  }

  _onContinue() {
    const text = this._text.trim();
    if (!text) return;
    setSideDescription(this._side, {
      kind: "note",
      text,
      source: "typed",
      validated: false,
      validation: {
        whatYouCanSee: false,
        whereItIs: false,
      },
    });
    navigate("/check");
  }
}

customElements.define("describe-instead", DescribeInstead);
