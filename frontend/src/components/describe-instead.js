// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/**
 * Describe Instead flow for one side of the perimeter check.
 * Persists typed input, validates it, and returns to the capture flow.
 */
import { getSite } from "../db.js";
import { currentRoute, navigate } from "../router.js";
import {
  getFlowType,
  getCurrentCheck,
  loadDraft,
  getActiveSideIndex,
  getSideOrder,
  getSideDescription,
  setSideDescription,
  setPostDescribeAction,
} from "../state/check-session.js";
import { DESCRIPTION_MAX_LENGTH, shell } from "./describe-instead.templates.js";

class DescribeInstead extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    this._routeBase = currentRoute().startsWith("/problem")
      ? "/problem"
      : "/check";
    const expectedFlow =
      this._routeBase === "/problem" ? "single-problem" : "perimeter";
    const check = getCurrentCheck() || (await loadDraft(expectedFlow));
    if (!check || !this._site) {
      navigate(this._routeBase);
      return;
    }

    this._flowType = getFlowType();
    this._routeBase =
      this._flowType === "single-problem" ? "/problem" : "/check";
    this._sides = getSideOrder();
    this._sideIndex = getActiveSideIndex() ?? 0;
    this._side = this._sides[this._sideIndex] || this._sides[0];
    this._savedDescription = getSideDescription(this._side);
    this._savedText = this._savedDescription?.text || "";
    this._text = this._savedText;
    this._programmaticFieldUpdate = false;

    this._render();
    this._bind();
  }

  _bind() {
    this._field = this.querySelector("#describe-text");
    this._continue = this.querySelector("#describe-continue");
    this._dialog = this.querySelector("#describe-exit-modal");
    this._clear = this.querySelector("#describe-clear");
    this._field.value = this._text;

    this.querySelector("#describe-close").addEventListener("click", () =>
      this._onClose(),
    );
    this.querySelector("#describe-dismiss").addEventListener("click", () =>
      this._onClose(),
    );
    this.querySelector("#describe-continue").addEventListener("click", () =>
      this._onContinue(),
    );
    this._clear.addEventListener("click", () => this._clearAll());
    this.querySelector("#describe-discard").addEventListener("click", () =>
      this._discardAndExit(),
    );
    this._dialog.addEventListener("cancel", (event) => event.preventDefault());
    this._field.addEventListener("input", (event) => {
      this._text = this._clampText(event.target.value);
      if (event.target.value !== this._text) {
        this._programmaticFieldUpdate = true;
        this._field.value = this._text;
        this._programmaticFieldUpdate = false;
      }
      this._continue.disabled = !this._text.trim();
      this._syncClearUi();
    });

    this._syncClearUi();
    this._field.focus();
    this._field.setSelectionRange(
      this._field.value.length,
      this._field.value.length,
    );
  }

  _render() {
    this.innerHTML = shell({
      text: this._text,
      hasText: Boolean(this._text.trim()),
    });
  }

  _syncClearUi() {
    if (!this._clear) return;
    this._clear.disabled = !this._text.trim();
  }

  _clearAll() {
    this._programmaticFieldUpdate = true;
    this._field.value = "";
    this._programmaticFieldUpdate = false;
    this._text = "";
    this._savedText = "";
    this._savedDescription = null;
    setSideDescription(this._side, null);
    this._syncClearUi();
    this._field.focus();
  }

  _hasUnsavedChanges() {
    return this._text !== this._savedText;
  }

  _clampText(text) {
    return text.slice(0, DESCRIPTION_MAX_LENGTH);
  }

  _onClose() {
    if (!this._hasUnsavedChanges()) {
      this._returnToCurrentSide();
      navigate(this._routeBase);
      return;
    }
    this._dialog.showModal();
  }

  _discardAndExit() {
    this._dialog.close();
    this._returnToCurrentSide();
    navigate(this._routeBase);
  }

  async _onContinue() {
    const text = this._text.trim();
    if (!text) return;
    setSideDescription(this._side, {
      kind: "note",
      text,
      source: "typed",
      validated: true,
      validation: {
        whatYouCanSee: true,
        whereItIs: true,
      },
    });
    if (this._flowType === "single-problem") {
      navigate(this._routeBase);
      return;
    }
    setPostDescribeAction({ type: "stay", sideIndex: this._sideIndex });
    navigate(this._routeBase);
  }

  _returnToCurrentSide() {
    if (this._flowType !== "perimeter") return;
    setPostDescribeAction({ type: "stay", sideIndex: this._sideIndex });
  }
}

customElements.define("describe-instead", DescribeInstead);
