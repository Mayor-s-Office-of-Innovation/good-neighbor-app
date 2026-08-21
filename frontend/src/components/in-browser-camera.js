// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  in-browser-camera — opt-in INLINE live camera embedded in the perimeter-check
  screen (behind ?webcam; see services/capture-mode.js). Unlike the native path
  (a hidden <input type="file"> handoff to the device camera), this keeps the user
  in-app: a persistent live <video> is the main element, a shutter sits below it,
  and each capture emits a JPEG data-URL that the host turns into a thumbnail. The
  camera stays live across captures and sides — the host never tears it down mid-
  check, so the stream isn't restarted per shot.

  Ported (vanilla) from street-conditions' react-webcam CameraView: pinch-to-zoom
  uses the camera's HARDWARE zoom where the track exposes it (Android Chrome), and
  falls back to a DIGITAL canvas center-crop everywhere else (incl. iOS Safari).
  Quality detection, front/back flip, save-to-device are out of this first pass.

  Events (bubbling, composed):
    "capture"     detail { dataUrl }  — a photo was taken; camera stays live.
    "unavailable"                     — no camera / permission denied; the host
                                        should fall back to the native file input.

  This whole feature is intentionally isolated (this file + shellWebcam template +
  a `_webcam` branch in perimeter-check.js) so it can be removed cleanly later.
*/
const DIGITAL_ZOOM_MAX = 4;
const JPEG_QUALITY = 0.85;
// Cap the saved image's longest side so encode stays cheap and the base64 stored in
// the IndexedDB draft stays bounded, even if getUserMedia hands us a large frame.
// The analyzer worker downscales again server-side, so this loses nothing useful.
const MAX_CAPTURE_DIM = 1600;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function pinchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

class InBrowserCamera extends HTMLElement {
  async connectedCallback() {
    // Zoom config resolved once the stream is live. mode: none | digital | hardware.
    this._zoom = {
      mode: "none",
      level: 1,
      min: 1,
      max: 1,
      step: 0.1,
      track: null,
    };
    this._pinch = { active: false, startDistance: 0, startZoom: 1 };
    this._stream = null;
    this._zoomRaf = null;
    this._pendingZoom = null;

    this.innerHTML = `
      <div class="ibcam">
        <div class="ibcam__stage" id="ibcam-stage">
          <video class="ibcam__video" id="ibcam-video" playsinline autoplay muted></video>
          <canvas class="ibcam__canvas visually-hidden" id="ibcam-canvas"></canvas>
          <span class="ibcam__zoom" id="ibcam-zoom" role="status" aria-live="polite" hidden></span>
        </div>
        <button class="ibcam__shutter" id="ibcam-shutter" type="button" aria-label="Take photo" disabled></button>
      </div>
    `;

    this._stage = this.querySelector("#ibcam-stage");
    this._video = this.querySelector("#ibcam-video");
    this._canvas = this.querySelector("#ibcam-canvas");
    this._zoomBadge = this.querySelector("#ibcam-zoom");
    this._shutter = this.querySelector("#ibcam-shutter");

    this._shutter.addEventListener("click", () => this._capture());
    // The shutter stays disabled until the stream can actually be snapshotted, so a
    // tap never silently no-ops during a slow camera start / autoplay hold.
    this._video.addEventListener("loadedmetadata", () => {
      if (this._video.videoWidth) this._shutter.disabled = false;
    });

    this._stage.addEventListener("touchstart", (e) => this._onTouchStart(e), {
      passive: false,
    });
    this._stage.addEventListener("touchmove", (e) => this._onTouchMove(e), {
      passive: false,
    });
    this._stage.addEventListener("touchend", () => this._onTouchEnd());

    await this._start();
  }

  /* ---- stream lifecycle ---- */
  async _start() {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || !mediaDevices.getUserMedia) {
      this._emitUnavailable();
      return;
    }
    try {
      this._stream = await mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch {
      // Denied or no camera → host falls back to the native file input.
      this._emitUnavailable();
      return;
    }
    if (!this.isConnected) {
      // Removed while the permission prompt was open — drop the stream.
      this._stopStream();
      return;
    }
    this._video.srcObject = this._stream;
    // Some browsers need an explicit play() after setting srcObject.
    this._video.play?.().catch(() => {});
    // If the track ends later (OS reclaim, permission revoked, backgrounding), the
    // preview freezes — surface it as unavailable so the host restores a capture
    // path. Note: track.stop() (our own teardown) does NOT fire "ended".
    this._stream
      .getVideoTracks?.()
      .forEach((t) =>
        t.addEventListener("ended", () => this._emitUnavailable()),
      );
    this._initZoom();
  }

  _emitUnavailable() {
    if (this._unavailable) return; // emit once
    this._unavailable = true;
    this.dispatchEvent(
      new CustomEvent("unavailable", { bubbles: true, composed: true }),
    );
  }

  _stopStream() {
    if (this._zoomRaf) {
      cancelAnimationFrame(this._zoomRaf);
      this._zoomRaf = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
  }

  /* ---- zoom (hardware where available, digital fallback) ---- */
  _initZoom() {
    const track = this._stream?.getVideoTracks?.()[0] || null;
    if (!track || typeof track.getCapabilities !== "function") {
      this._zoom = {
        mode: track ? "digital" : "none",
        level: 1,
        min: 1,
        max: DIGITAL_ZOOM_MAX,
        step: 0.01,
        track: null,
      };
      this._reflectZoom();
      return;
    }
    const caps = track.getCapabilities();
    const hw =
      caps?.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > 1;
    if (!hw) {
      this._zoom = {
        mode: "digital",
        level: 1,
        min: 1,
        max: DIGITAL_ZOOM_MAX,
        step: 0.01,
        track: null,
      };
      this._reflectZoom();
      return;
    }
    const min = typeof caps.zoom.min === "number" ? caps.zoom.min : 1;
    const max = typeof caps.zoom.max === "number" ? caps.zoom.max : min;
    const step =
      typeof caps.zoom.step === "number" && caps.zoom.step > 0
        ? caps.zoom.step
        : 0.1;
    this._zoom = { mode: "hardware", level: min, min, max, step, track };
    track.applyConstraints({ advanced: [{ zoom: min }] }).catch(() => {});
    this._reflectZoom();
  }

  // Digital zoom shows live via a CSS scale on the video; hardware zoom is applied
  // to the track (rAF-throttled) so the stream itself is already zoomed.
  _setZoom(next) {
    const z = this._zoom;
    if (z.mode === "none") return;
    const level = clamp(next, z.min, z.max);
    z.level = level;
    if (z.mode === "digital") {
      this._video.style.transform = `scale(${level})`;
    } else if (z.mode === "hardware") {
      this._pendingZoom =
        z.step > 0 ? Math.round(level / z.step) * z.step : level;
      if (!this._zoomRaf) {
        this._zoomRaf = requestAnimationFrame(() => {
          this._zoomRaf = null;
          const v = this._pendingZoom;
          if (typeof v === "number") {
            z.track
              ?.applyConstraints({ advanced: [{ zoom: v }] })
              .catch(() => {});
          }
        });
      }
    }
    this._reflectZoom();
  }

  _reflectZoom() {
    if (this._zoom.mode === "none") {
      this._zoomBadge.hidden = true;
      return;
    }
    this._zoomBadge.hidden = false;
    this._zoomBadge.textContent = `${this._zoom.level.toFixed(1)}×`;
  }

  _onTouchStart(e) {
    if (this._zoom.mode === "none" || e.touches.length !== 2) return;
    e.preventDefault();
    this._pinch = {
      active: true,
      startDistance: pinchDistance(e.touches),
      startZoom: this._zoom.level,
    };
  }

  _onTouchMove(e) {
    if (!this._pinch.active || e.touches.length !== 2) return;
    e.preventDefault();
    const dist = pinchDistance(e.touches);
    if (!dist || !this._pinch.startDistance) return;
    this._setZoom(this._pinch.startZoom * (dist / this._pinch.startDistance));
  }

  _onTouchEnd() {
    this._pinch.active = false;
  }

  /* ---- capture (stays live; host manages thumbnails) ---- */
  _capture() {
    const dataUrl = this._snapshot();
    if (!dataUrl) return;
    // Brief flash so the tap registers (there's no separate review step).
    this._stage.classList.add("ibcam__stage--flash");
    setTimeout(() => this._stage.classList.remove("ibcam__stage--flash"), 160);
    this.dispatchEvent(
      new CustomEvent("capture", {
        detail: { dataUrl },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // Draw the current frame to a canvas → JPEG data-URL, downscaled to MAX_CAPTURE_DIM.
  // Digital zoom takes the center crop as the source region (so the saved photo
  // matches the scaled preview); hardware zoom is already baked into the stream.
  _snapshot() {
    const video = this._video;
    const sw = video.videoWidth;
    const sh = video.videoHeight;
    if (!sw || !sh) return null;

    const ctx = this._canvas.getContext("2d");
    if (!ctx) return null;

    // Source region: center crop under digital zoom, full frame otherwise.
    const z = this._zoom.mode === "digital" ? this._zoom.level : 1;
    const cw = sw / z;
    const ch = sh / z;
    const cx = (sw - cw) / 2;
    const cy = (sh - ch) / 2;

    // Output size: cap the longest side, never upscale.
    const scale = Math.min(1, MAX_CAPTURE_DIM / Math.max(cw, ch));
    const dw = Math.round(cw * scale);
    const dh = Math.round(ch * scale);
    this._canvas.width = dw;
    this._canvas.height = dh;

    ctx.drawImage(video, cx, cy, cw, ch, 0, 0, dw, dh);
    return this._canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  disconnectedCallback() {
    this._stopStream();
  }
}

customElements.define("in-browser-camera", InBrowserCamera);
