// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/**
 * Describe Instead — text evidence as the alternative to photos.
 *
 * One code path for both flows: Continue files the typed text as a kind:"text"
 * item through the same incremental pipeline as photos, so it is analyzed and
 * counted exactly like a photo. For the perimeter check there is ONE
 * description per check (docs/plan-remove-places.md): opening this screen
 * again edits the saved description, and saving a change replaces it.
 */
import { getSite } from "../db.js";
import { currentRoute, navigate } from "../router.js";
import {
  addItem,
  getFlowType,
  getCurrentCheck,
  getCapturePlaceId,
  loadDraft,
  updateItem,
} from "../state/check-session.js";
import {
  MIN_DESCRIPTION_LENGTH,
  MIN_TEXT_EVIDENCE_LENGTH,
  textItems,
} from "../domain/check-completion.js";
import {
  analyzeEvidenceItem,
  removeEvidenceItem,
} from "../services/photo-analysis.js";
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
    this._placeId = getCapturePlaceId();
    // The perimeter description must describe the whole area, so it carries a
    // minimum length; a single-issue note only has to clear the backend's
    // text-artifact minimum (the analyzer rejects shorter text permanently).
    this._minLength =
      this._flowType === "perimeter"
        ? MIN_DESCRIPTION_LENGTH
        : MIN_TEXT_EVIDENCE_LENGTH;
    this._existing =
      this._flowType === "perimeter" ? textItems(check)[0] || null : null;
    this._savedText = this._existing?.text || "";
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
      this._continue.disabled = !this._canContinue();
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
      flowType: this._flowType,
      minLength: this._minLength,
      hasText: Boolean(this._text.trim()),
      canContinue: this._canContinue(),
    });
  }

  _canContinue() {
    return this._text.trim().length >= this._minLength;
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
    this._continue.disabled = true;
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
      navigate(this._routeBase);
      return;
    }
    this._dialog.showModal();
  }

  _discardAndExit() {
    this._dialog.close();
    navigate(this._routeBase);
  }

  async _onContinue() {
    const text = this._text.trim();
    if (!this._canContinue()) return;
    if (this._existing) {
      if (text === this._savedText.trim()) {
        navigate(this._routeBase);
        return;
      }
      // Replace, don't append: one description per check. The old text was
      // already registered as an artifact — delete it server-side too, or
      // completeCheck folds the stale description into the scorecard. A failed
      // delete must not half-apply the edit (that would file BOTH texts), so
      // stay on the screen and let the user retry.
      try {
        await removeEvidenceItem(
          this._existing.placeId || this._placeId,
          this._existing.id,
        );
      } catch (err) {
        console.error("Could not replace the saved description", err);
        return;
      }
    }
    // Typed text is real evidence: file it as a text item through the same
    // incremental pipeline as photos, so Done's capture-complete path counts
    // it and the backend never misses a text-only check.
    const record = addItem(this._placeId, { kind: "text", text });
    updateItem(this._placeId, record.id, {
      upload: { status: "uploaded" },
    });
    analyzeEvidenceItem(this._placeId, record.id);
    navigate(this._routeBase);
  }
}

customElements.define("describe-instead", DescribeInstead);
