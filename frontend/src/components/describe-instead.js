/**
 * Describe Instead flow for one side of the perimeter check.
 * Persists text/voice input, validates it, and returns to the capture flow.
 */
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import { validateSideDescription } from "../services/api.js";
import {
  SIDES,
  getCurrentCheck,
  getActiveSideIndex,
  getSideDescription,
  setSideDescription,
  setSideDescriptionValidation,
  setPostDescribeAction,
} from "../state/check-session.js";
import { startTranscribeSession } from "../services/web-speech-transcribe.js";
import { DESCRIPTION_MAX_LENGTH, shell } from "./describe-instead.templates.js";

class DescribeInstead extends HTMLElement {
  async connectedCallback() {
    this._site = await getSite();
    const check = getCurrentCheck();
    if (!check || !this._site) {
      navigate("/check");
      return;
    }

    this._sideIndex = getActiveSideIndex();
    this._side = SIDES[this._sideIndex] || SIDES[0];
    this._savedDescription = getSideDescription(this._side);
    this._savedText = this._savedDescription?.text || "";
    this._text = this._savedText;
    this._voiceState = "idle";
    this._voiceError = "";
    this._validationState = "idle";
    this._validationError = "";
    this._transcribeSession = null;
    this._transcribeRunId = 0;
    this._inputSource =
      this._savedDescription?.source || (this._savedText ? "typed" : null);
    this._validation = this._savedDescription?.validation || {
      whatYouCanSee: false,
      whereItIs: false,
    };
    this._programmaticFieldUpdate = false;

    this._render();
    this._bind();
  }

  _bind() {
    this._field = this.querySelector("#describe-text");
    this._continue = this.querySelector("#describe-continue");
    this._dialog = this.querySelector("#describe-exit-modal");
    this._voice = this.querySelector("#describe-voice");
    this._clear = this.querySelector("#describe-clear");
    this._voiceStatus = this.querySelector("#describe-voice-status");
    this._validationStatus = this.querySelector("#describe-validation-status");
    this._whatChip = this.querySelector("#describe-chip-what");
    this._whereChip = this.querySelector("#describe-chip-where");
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
    this._voice.addEventListener("click", () => this._toggleVoice());
    this._clear.addEventListener("click", () => this._clearAll());
    this.querySelector("#describe-discard").addEventListener("click", () =>
      this._discardAndExit(),
    );
    this._dialog.addEventListener("cancel", (event) => event.preventDefault());
    this._field.addEventListener("input", (event) => {
      if (!this._programmaticFieldUpdate && this._voiceState === "recording") {
        this._programmaticFieldUpdate = true;
        this._field.value = this._text;
        this._programmaticFieldUpdate = false;
        return;
      }
      this._text = this._clampText(event.target.value);
      if (event.target.value !== this._text) {
        this._programmaticFieldUpdate = true;
        this._field.value = this._text;
        this._programmaticFieldUpdate = false;
      }
      this._continue.disabled = !this._text.trim();
      if (!this._programmaticFieldUpdate) {
        this._inputSource =
          this._inputSource === "transcribed" || this._inputSource === "mixed"
            ? "mixed"
            : "typed";
        this._validation = {
          whatYouCanSee: false,
          whereItIs: false,
        };
        this._validationState = "idle";
        this._validationError = "";
      }
      this._syncVoiceLabel();
      this._syncValidationUi();
      this._syncClearUi();
    });

    this._syncVoiceUi();
    this._syncValidationUi();
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

  _syncVoiceLabel() {
    if (!this._voice) return;
    if (this._voiceState === "recording") {
      this._voice.textContent = "Stop recording";
      return;
    }
    if (this._voiceState === "processing") {
      this._voice.textContent = "Processing…";
      return;
    }
    this._voice.textContent = this._text.trim()
      ? "Add more by voice"
      : "Use voice";
  }

  _syncVoiceUi() {
    this._syncVoiceLabel();
    if (this._field) {
      this._field.readOnly =
        this._voiceState === "recording" || this._voiceState === "processing";
    }
    if (this._voice) {
      this._voice.disabled = this._voiceState === "processing";
      this._voice.dataset.state = this._voiceState;
      if (this._voiceState === "processing") {
        this._voice.setAttribute("aria-busy", "true");
      } else {
        this._voice.removeAttribute("aria-busy");
      }
    }
    if (this._continue) {
      this._continue.disabled =
        !this._text.trim() ||
        this._voiceState === "recording" ||
        this._voiceState === "processing" ||
        this._validationState === "loading";
      this._continue.textContent =
        this._validationState === "loading" ? "Checking…" : "Continue";
    }
    if (!this._voiceStatus) return;
    if (this._voiceError) {
      this._voiceStatus.removeAttribute("aria-hidden");
      this._voiceStatus.textContent = this._voiceError;
      this._voiceStatus.dataset.kind = "error";
      this._voiceStatus.setAttribute("role", "alert");
      return;
    }
    if (this._voiceState === "processing") {
      this._voiceStatus.removeAttribute("aria-hidden");
      this._voiceStatus.textContent = "Processing transcript…";
      this._voiceStatus.dataset.kind = "";
      this._voiceStatus.setAttribute("role", "status");
      return;
    }
    this._voiceStatus.setAttribute("aria-hidden", "true");
    this._voiceStatus.textContent = "";
    delete this._voiceStatus.dataset.kind;
    this._voiceStatus.removeAttribute("role");
  }

  _syncClearUi() {
    if (!this._clear) return;
    this._clear.disabled = !this._text.trim();
  }

  _setVoiceState(state, error = "") {
    this._voiceState = state;
    this._voiceError = error;
    this._syncVoiceUi();
  }

  _syncValidationUi() {
    if (this._whatChip) {
      this._whatChip.dataset.complete = this._validation.whatYouCanSee
        ? "true"
        : "false";
    }
    if (this._whereChip) {
      this._whereChip.dataset.complete = this._validation.whereItIs
        ? "true"
        : "false";
    }
    if (this._validationStatus) {
      if (this._validationState === "loading") {
        this._validationStatus.removeAttribute("aria-hidden");
        this._validationStatus.textContent = "Checking description…";
        this._validationStatus.dataset.kind = "";
        this._validationStatus.setAttribute("role", "status");
      } else if (this._validationError) {
        this._validationStatus.removeAttribute("aria-hidden");
        this._validationStatus.textContent =
          "Please share only things you can see, and make sure to describe where you see them.";
        this._validationStatus.dataset.kind = "error";
        this._validationStatus.setAttribute("role", "alert");
      } else {
        this._validationStatus.setAttribute("aria-hidden", "true");
        this._validationStatus.textContent = "";
        delete this._validationStatus.dataset.kind;
        this._validationStatus.removeAttribute("role");
      }
    }
    this._syncClearUi();
    this._syncVoiceUi();
  }

  _clearAll() {
    this._programmaticFieldUpdate = true;
    this._field.value = "";
    this._programmaticFieldUpdate = false;
    this._text = "";
    this._savedText = "";
    this._savedDescription = null;
    this._inputSource = null;
    this._validation = {
      whatYouCanSee: false,
      whereItIs: false,
    };
    this._validationState = "idle";
    this._validationError = "";
    this._voiceError = "";
    setSideDescription(this._side, null);
    this._syncValidationUi();
    this._field.focus();
  }

  _appendTranscript(text) {
    const incoming = text.trim();
    if (!incoming) return;
    const next = this._text.trim()
      ? `${this._text.trim()} ${incoming}`
      : incoming;
    const bounded = this._clampText(next);
    this._programmaticFieldUpdate = true;
    this._field.value = bounded;
    this._programmaticFieldUpdate = false;
    this._text = bounded;
    if (this._inputSource === "typed" || this._inputSource === "mixed") {
      this._inputSource = "mixed";
    } else if (this._inputSource === "transcribed") {
      this._inputSource = "transcribed";
    } else {
      this._inputSource = "transcribed";
    }
  }

  _previewTranscript(live) {
    // Live-only: paint the field with the base text plus what's been heard so far,
    // without touching this._text — `done` performs the real append on stop. Mirrors
    // _appendTranscript's join so the text doesn't shift when recording ends.
    if (this._voiceState !== "recording" || !this._field) return;
    const base = (this._voiceBaseText || "").trim();
    const incoming = live.trim();
    const next = base ? (incoming ? `${base} ${incoming}` : base) : incoming;
    const bounded = this._clampText(next);
    this._programmaticFieldUpdate = true;
    this._field.value = bounded;
    this._programmaticFieldUpdate = false;
    // Keep the growing tail in view as it fills past the visible rows.
    this._field.scrollTop = this._field.scrollHeight;
  }

  async _toggleVoice() {
    if (this._voiceState === "processing") return;
    if (this._transcribeSession && this._voiceState === "recording") {
      await this._stopVoice();
      return;
    }
    await this._startVoice();
  }

  async _startVoice() {
    this._setVoiceState("idle", "");
    // Snapshot the text as it stands before this recording. Live preview renders on
    // top of this base; the authoritative append happens once, on `done`.
    this._voiceBaseText = this._text;
    try {
      const session = await startTranscribeSession({
        siteId: this._site.siteId || this._site.providerSiteId || this._site.id,
        onStateChange: (state) => this._setVoiceState(state),
        onTranscript: (live) => this._previewTranscript(live),
      });
      this._transcribeSession = session;
      const runId = ++this._transcribeRunId;
      session.done
        .then((result) => {
          if (
            this._transcribeSession !== session ||
            runId !== this._transcribeRunId
          ) {
            return;
          }
          this._appendTranscript(result.text);
          this._setVoiceState("idle", "");
        })
        .catch((error) => {
          if (
            this._transcribeSession !== session ||
            runId !== this._transcribeRunId
          ) {
            return;
          }
          this._setVoiceState("idle", error.message);
        })
        .finally(() => {
          if (
            this._transcribeSession !== session ||
            runId !== this._transcribeRunId
          ) {
            return;
          }
          this._transcribeSession = null;
          this._syncVoiceUi();
        });
      this._setVoiceState("recording");
    } catch (error) {
      this._transcribeSession = null;
      this._setVoiceState("idle", error.message);
    }
  }

  async _stopVoice() {
    if (!this._transcribeSession) return;
    await this._transcribeSession.stop();
  }

  _hasUnsavedChanges() {
    return this._text !== this._savedText;
  }

  _clampText(text) {
    return text.slice(0, DESCRIPTION_MAX_LENGTH);
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
    if (this._transcribeSession) {
      void this._cancelVoice();
    }
    navigate("/check");
  }

  async _cancelVoice() {
    if (!this._transcribeSession) return;
    const session = this._transcribeSession;
    const runId = this._transcribeRunId;
    try {
      await session.cancel();
      this._setVoiceState("idle", "");
    } catch (error) {
      if (
        this._transcribeSession === session &&
        runId === this._transcribeRunId
      ) {
        this._setVoiceState("idle", error.message);
      }
    } finally {
      if (
        this._transcribeSession === session &&
        runId === this._transcribeRunId
      ) {
        this._transcribeSession = null;
        this._syncVoiceUi();
      }
    }
  }

  disconnectedCallback() {
    if (this._transcribeSession) {
      void this._cancelVoice();
    }
  }

  async _onContinue() {
    const text = this._text.trim();
    if (!text) return;
    this._validationState = "loading";
    this._validationError = "";
    this._syncValidationUi();
    try {
      const result = await validateSideDescription(
        this._siteCheckId(),
        this._side,
        {
          text,
        },
      );
      this._validation = {
        whatYouCanSee: Boolean(result.whatYouCanSee),
        whereItIs: Boolean(result.whereItIs),
      };
      const accepted =
        this._validation.whatYouCanSee && this._validation.whereItIs;
      setSideDescription(this._side, {
        kind: "note",
        text,
        source: this._inputSource || "typed",
        validated: accepted,
        validation: this._validation,
      });
      if (!accepted) {
        this._validationState = "idle";
        this._validationError =
          result.message || "Add what you can see and where the issue is.";
        this._syncValidationUi();
        return;
      }
      setSideDescriptionValidation(this._side, this._validation);
      this._validationState = "idle";
      this._validationError = "";
      this._syncValidationUi();
      setPostDescribeAction(
        this._sideIndex === SIDES.length - 1
          ? { type: "submit" }
          : { type: "advance", sideIndex: this._sideIndex + 1 },
      );
      navigate("/check");
    } catch (error) {
      this._validationState = "idle";
      this._validationError =
        error?.body?.message ||
        error?.message ||
        "We couldn’t check this description right now. Try again.";
      this._syncValidationUi();
    }
  }

  _siteCheckId() {
    const check = getCurrentCheck();
    return check?.id || "";
  }

  _saveDraftDescription() {
    setSideDescription(this._side, {
      kind: "note",
      text: this._text.trim(),
      source: this._inputSource || "typed",
      validated: false,
      validation: this._validation,
    });
  }
}

customElements.define("describe-instead", DescribeInstead);
