// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
import { getSite } from "../db.js";
import { navigate } from "../router.js";
import {
  SIDES,
  getCurrentCheck,
  getActiveSideIndex,
  getSideDescription,
  setSideDescription,
} from "../state/check-session.js";
import { startTranscribeSession } from "../services/transcribe-stream.js";
import { shell } from "./describe-instead.templates.js";

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
    this._transcribeSession = null;
    this._inputSource =
      this._savedDescription?.source || (this._savedText ? "typed" : null);
    this._programmaticFieldUpdate = false;

    this._render();
    this._bind();
  }

  _bind() {
    this._field = this.querySelector("#describe-text");
    this._continue = this.querySelector("#describe-continue");
    this._dialog = this.querySelector("#describe-exit-modal");
    this._voice = this.querySelector("#describe-voice");
    this._voiceStatus = this.querySelector("#describe-voice-status");
    this._field.value = this._text;

    this.querySelector("#describe-close").addEventListener("click", () =>
      this._onClose(),
    );
    this.querySelector("#describe-dismiss").addEventListener("click", () =>
      this._onClose(),
    );
    this.querySelector("#describe-continue").addEventListener("click", () => this._onContinue());
    this._voice.addEventListener("click", () => this._toggleVoice());
    this.querySelector("#describe-discard").addEventListener("click", () =>
      this._discardAndExit(),
    );
    this._dialog.addEventListener("cancel", (event) => event.preventDefault());
    this._field.addEventListener("input", (event) => {
      this._text = event.target.value;
      this._continue.disabled = !this._text.trim();
      if (!this._programmaticFieldUpdate) {
        this._inputSource =
          this._inputSource === "transcribed" || this._inputSource === "mixed"
            ? "mixed"
            : "typed";
      }
      this._syncVoiceLabel();
    });

    this._syncVoiceUi();
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
    if (!this._voice) return;
    if (this._voiceState === "recording") {
      this._voice.textContent = "Stop recording";
      return;
    }
    if (this._voiceState === "processing") {
      this._voice.textContent = "Processing…";
      return;
    }
    this._voice.textContent = this._text.trim() ? "Add more by voice" : "Use voice";
  }

  _syncVoiceUi() {
    this._syncVoiceLabel();
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
        !this._text.trim() || this._voiceState === "recording" || this._voiceState === "processing";
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

  _setVoiceState(state, error = "") {
    this._voiceState = state;
    this._voiceError = error;
    this._syncVoiceUi();
  }

  _appendTranscript(text) {
    const incoming = text.trim();
    if (!incoming) return;
    const next = this._text.trim()
      ? `${this._text.trim()} ${incoming}`
      : incoming;
    this._programmaticFieldUpdate = true;
    this._field.value = next;
    this._programmaticFieldUpdate = false;
    this._text = next;
    if (this._inputSource === "typed" || this._inputSource === "mixed") {
      this._inputSource = "mixed";
    } else if (this._inputSource === "transcribed") {
      this._inputSource = "transcribed";
    } else {
      this._inputSource = "transcribed";
    }
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
    try {
      this._transcribeSession = await startTranscribeSession({
        siteId: this._site.siteId || this._site.providerSiteId || this._site.id,
        onStateChange: (state) => this._setVoiceState(state),
      });
      this._setVoiceState("recording");
    } catch (error) {
      this._transcribeSession = null;
      this._setVoiceState("idle", error.message);
    }
  }

  async _stopVoice() {
    if (!this._transcribeSession) return;
    try {
      const result = await this._transcribeSession.stop();
      this._appendTranscript(result.text);
      this._setVoiceState("idle", "");
    } catch (error) {
      this._setVoiceState("idle", error.message);
    } finally {
      this._transcribeSession = null;
      this._syncVoiceUi();
    }
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
    if (this._transcribeSession) {
      void this._cancelVoice();
    }
    navigate("/check");
  }

  async _cancelVoice() {
    if (!this._transcribeSession) return;
    try {
      await this._transcribeSession.cancel();
      this._setVoiceState("idle", "");
    } catch (error) {
      this._setVoiceState("idle", error.message);
    } finally {
      this._transcribeSession = null;
      this._syncVoiceUi();
    }
  }

  disconnectedCallback() {
    if (this._transcribeSession) {
      void this._cancelVoice();
    }
  }

  _onContinue() {
    const text = this._text.trim();
    if (!text) return;
    setSideDescription(this._side, {
      kind: "note",
      text,
      source: this._inputSource || "typed",
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
