// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  capture-audio — record a short voice note. Mirrors care-connect's approach:
  getUserMedia({ audio: { channelCount: 1 } }) + MediaRecorder, accumulating chunks
  into a Blob on stop. Phase 1 stores the Blob and mocks transcription on submit —
  no PCM downsample / upload here (that lives in the live-transcription work).

  Exposes `this.blob` (audio Blob or null). Light DOM. 180s cap like care-connect.
  Degrades gracefully if MediaRecorder / getUserMedia is unavailable.
*/
const MAX_MS = 180000;

class CaptureAudio extends HTMLElement {
  connectedCallback() {
    this.blob = null;
    this._chunks = [];
    this._recorder = null;
    this._stream = null;
    this._url = null;
    this._timer = null;

    const supported =
      typeof MediaRecorder !== "undefined" &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia;

    this.innerHTML = `
      <div class="stack stack--tight">
        <span id="audio-label" style="font-weight:600">Voice note</span>
        <div role="group" aria-labelledby="audio-label" class="stack stack--tight">
          <wa-button type="button" appearance="outlined" id="rec-btn" ${supported ? "" : "disabled"}>
            <wa-icon slot="start" name="microphone" id="rec-icon"></wa-icon>
            <span class="btn-label">Record</span>
          </wa-button>
          <p class="hint" id="rec-status" role="status" aria-live="polite">
            ${supported ? "Not recording." : "Audio recording is not supported on this device."}
          </p>
          <div class="media-preview" id="audio-preview" hidden>
            <audio id="audio-el" controls></audio>
          </div>
        </div>
      </div>
    `;
    this._btn = this.querySelector("#rec-btn");
    this._label = this.querySelector("#rec-btn .btn-label");
    this._icon = this.querySelector("#rec-icon");
    this._status = this.querySelector("#rec-status");
    this._preview = this.querySelector("#audio-preview");
    this._audio = this.querySelector("#audio-el");

    if (supported) {
      this._btn.addEventListener("click", () => this._toggle());
    }
  }

  _setBtn(icon, label, variant) {
    this._icon.name = icon;
    this._label.textContent = label;
    if (variant) this._btn.setAttribute("variant", variant);
    else this._btn.removeAttribute("variant");
  }

  async _toggle() {
    if (this._recorder && this._recorder.state === "recording") {
      this._stop();
      return;
    }
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      });
    } catch {
      this._status.textContent = "Microphone permission was denied.";
      return;
    }
    this._chunks = [];
    this._recorder = new MediaRecorder(this._stream);
    this._recorder.ondataavailable = (e) => {
      if (e.data.size) this._chunks.push(e.data);
    };
    this._recorder.onstop = () => this._finalize();
    this._recorder.start();
    this._setBtn("circle-stop", "Stop", "danger");
    this._status.textContent = "Recording…";
    this._timer = setTimeout(() => this._stop(), MAX_MS);
  }

  _stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._recorder && this._recorder.state !== "inactive")
      this._recorder.stop();
  }

  _finalize() {
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    const type = (this._recorder && this._recorder.mimeType) || "audio/webm";
    this.blob = new Blob(this._chunks, { type });
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = URL.createObjectURL(this.blob);
    this._audio.src = this._url;
    this._preview.hidden = false;
    this._setBtn("microphone", "Re-record");
    this._status.textContent = "Recording captured.";
    this.dispatchEvent(new CustomEvent("change"));
  }

  reset() {
    this._stop();
    if (this._url) {
      URL.revokeObjectURL(this._url);
      this._url = null;
    }
    this.blob = null;
    this._chunks = [];
    this._preview.hidden = true;
    if (this._btn) this._setBtn("microphone", "Record");
    if (this._status) this._status.textContent = "Not recording.";
  }

  disconnectedCallback() {
    this._stop();
    if (this._url) URL.revokeObjectURL(this._url);
  }
}
customElements.define("capture-audio", CaptureAudio);
