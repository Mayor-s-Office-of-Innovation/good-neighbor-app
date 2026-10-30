import { captureThumbnail } from "../services/capture-media.js";
import { getCaptureMedia } from "../db.js";
import {
  cachedMediaUrls,
  invalidateMediaUrls,
} from "../services/task-evidence.js";
import { t } from "../i18n/i18n.js";
import "./capture-photo.css";

/** A capture thumbnail owns only a small object URL. Originals are opened explicitly. */
export class CapturePhoto extends HTMLElement {
  static observedAttributes = ["data-artifact-id", "data-media-key"];
  _generation = 0;
  _attempts = 0;
  _url = "";
  _timer = null;
  _visible = false;
  _busy = false;
  _onReturn = () => {
    if (this._visible && !document.hidden) {
      this._attempts = 0;
      void this._refresh();
    }
  };
  connectedCallback() {
    this._generation++;
    this._image = this.querySelector("img");
    this._trigger = this.closest("button[data-photo-lightbox]");
    this._placeholder = /** @type {HTMLElement} */ (
      this.querySelector("[data-photo-placeholder]")
    );
    this._observer = new IntersectionObserver((entries) => {
      this._visible = entries[0]?.isIntersecting;
      if (this._visible && !document.hidden) void this._refresh();
    });
    this._observer.observe(this);
    window.addEventListener("online", this._onReturn);
    document.addEventListener("visibilitychange", this._onReturn);
  }
  attributeChangedCallback() {
    this._attempts = 0;
    if (this.isConnected && this._visible) void this._refresh();
  }
  async _refresh() {
    if (this._busy || this._url || !this._image || !this.isConnected) return;
    this._busy = true;
    const generation = this._generation;
    const artifactId = this.dataset.artifactId || "";
    try {
      const thumbnail = await captureThumbnail(
        this.dataset.mediaKey,
        this.dataset.checkId,
        artifactId,
      );
      if (generation !== this._generation || !this.isConnected) return;
      if (thumbnail) {
        this._url = URL.createObjectURL(thumbnail);
        this._image.src = this._url;
        this._image.hidden = false;
        this._placeholder.hidden = true;
        return;
      }
    } catch {
      /* A missing thumbnail never fetches the original. */
    } finally {
      this._busy = false;
    }
    if (generation !== this._generation || !this.isConnected) return;
    if (artifactId !== (this.dataset.artifactId || "")) {
      void this._refresh();
      return;
    }
    clearTimeout(this._timer);
    if (artifactId && navigator.onLine !== false && ++this._attempts < 6) {
      this._timer = setTimeout(
        () => {
          if (this._visible && !document.hidden) void this._refresh();
        },
        Math.min(30000, 2000 * 2 ** this._attempts),
      );
    } else if (this._attempts >= 6) {
      this._placeholder.setAttribute(
        "aria-label",
        t("card.evidence.unavailable"),
      );
    }
  }
  /** Fetch an original URL only for an explicit lightbox action. */
  async original() {
    const { mediaKey, checkId, artifactId } = this.dataset;
    if (artifactId && navigator.onLine !== false) {
      try {
        invalidateMediaUrls(checkId, artifactId);
        const urls = await cachedMediaUrls(checkId, artifactId);
        return { src: urls.downloadUrl, release: () => {} };
      } catch {
        /* Offline recovery can use the pending original or cached thumbnail. */
      }
    }
    const media = await getCaptureMedia(mediaKey);
    const blob = media?.original || media?.thumbnail;
    if (!blob) return null;
    const src = URL.createObjectURL(blob);
    return {
      src,
      previewOnly: !media.original,
      release: () => URL.revokeObjectURL(src),
    };
  }
  disconnectedCallback() {
    this._generation++;
    clearTimeout(this._timer);
    this._observer?.disconnect();
    window.removeEventListener("online", this._onReturn);
    document.removeEventListener("visibilitychange", this._onReturn);
    if (this._url) URL.revokeObjectURL(this._url);
    this._url = "";
  }
}
customElements.define("capture-photo", CapturePhoto);
