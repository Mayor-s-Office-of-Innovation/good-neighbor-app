import {
  cachedMediaUrls,
  invalidateMediaUrls,
  markMediaUnavailable,
} from "../services/task-evidence.js";
import { escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import "./artifact-photo.css";

/** Owns renewal and bounded recovery for one displayed photo. No credentials or
 * signed URLs are persisted. Offscreen/hidden images do not renew in the background.
 */
export class ArtifactPhoto extends HTMLElement {
  _onImageError = () => void this._recover();
  _onImageLoad = () => {
    this._imageRefreshed = false;
  };
  connectedCallback() {
    this._generation = (this._generation || 0) + 1;
    this._busy = false;
    this._trigger = this.closest("[data-photo-lightbox]");
    this._setTrigger("");
    const generation = this._generation;
    this._attempts = 0;
    this._visible = !globalThis.IntersectionObserver;
    this._onReturn = () => {
      if (!document.hidden && this._visible) void this._refresh();
    };
    document.addEventListener("visibilitychange", this._onReturn);
    queueMicrotask(() => {
      if (!this.isConnected || generation !== this._generation) return;
      this._image = this.querySelector("img");
      if (!this._image) return;
      this._placeholder = this.querySelector(".photo-placeholder");
      this._image.addEventListener("error", this._onImageError);
      this._image.addEventListener("load", this._onImageLoad);
      if (globalThis.IntersectionObserver) {
        this._observer = new IntersectionObserver((entries) => {
          this._visible = entries[0]?.isIntersecting;
          if (this._visible && !document.hidden) void this._refresh();
        });
        this._observer.observe(this);
      } else void this._refresh();
    });
  }
  disconnectedCallback() {
    this._generation++;
    clearTimeout(this._timer);
    this._observer?.disconnect();
    document.removeEventListener("visibilitychange", this._onReturn);
  }
  _schedule(delay) {
    clearTimeout(this._timer);
    this._timer = setTimeout(
      () => {
        if (this._visible && !document.hidden) void this._refresh();
      },
      Math.max(1000, delay),
    );
  }
  async _refresh() {
    if (this._busy || !this.isConnected || !this._image) return;
    const { checkId, artifactId } = this.dataset;
    const local = this._image.dataset.src || "";
    if (/^(blob:|data:)/.test(local)) {
      this._show(local, local);
      return;
    }
    if (!checkId || !artifactId) {
      const src = this._image.dataset.src;
      if (src) this._show(src, this.dataset.original || src);
      else this._missing();
      return;
    }
    this._busy = true;
    const generation = this._generation;
    try {
      const urls = await cachedMediaUrls(checkId, artifactId);
      if (!this.isConnected || generation !== this._generation) return;
      this._original = urls.downloadUrl;
      this._attempts = 0;
      this._show(
        (this._triedOriginal ? urls.downloadUrl : urls.thumbnailUrl) ||
          urls.downloadUrl,
        urls.downloadUrl,
      );
      this._schedule(urls.expiresAt - Date.now());
      return true;
    } catch {
      if (!this.isConnected || generation !== this._generation) return;
      this._missing();
      // Automatic API retries are bounded. A later navigation can try again,
      // subject to the shared failure backoff (including unavailable media).
      if (++this._attempts < 3) this._schedule(5000);
    } finally {
      if (generation === this._generation) this._busy = false;
    }
  }
  _show(src, original) {
    if (!src) {
      this._missing();
      return;
    }
    this.removeAttribute("data-unavailable");
    this._placeholder?.remove();
    this._setTrigger(original || src);
    if (this._image.getAttribute("src") !== src) this._image.src = src;
  }
  async _recover() {
    if (!this.isConnected || this._busy) return;
    const { checkId, artifactId } = this.dataset;
    // One fresh signing attempt, then the original if just the thumbnail failed.
    // Never bounce thumbnail -> original -> thumbnail indefinitely.
    if (!this._imageRefreshed && checkId && artifactId) {
      this._imageRefreshed = true;
      invalidateMediaUrls(checkId, artifactId);
      const refreshed = await this._refresh();
      if (refreshed && this._image.complete && !this._image.naturalWidth)
        void this._recover();
      return;
    }
    if (
      !this._triedOriginal &&
      this._original &&
      this._image.getAttribute("src") !== this._original
    ) {
      this._triedOriginal = true;
      this._show(this._original, this._original);
      return;
    }
    if (checkId && artifactId) markMediaUnavailable(checkId, artifactId);
    clearTimeout(this._timer);
    this._missing();
  }
  _missing() {
    this.setAttribute("data-unavailable", "");
    if (!this._placeholder?.isConnected) {
      this.insertAdjacentHTML(
        "beforeend",
        `<span class="photo-placeholder" role="img" aria-label="${escapeAttr(t("card.evidence.unavailable"))}"><wa-icon name="image-slash" aria-hidden="true"></wa-icon></span>`,
      );
      this._placeholder = this.lastElementChild;
    }
    this._setTrigger("");
  }
  _setTrigger(src) {
    if (!this._trigger) return;
    this._trigger.setAttribute("data-full-src", src);
    if (this._trigger instanceof HTMLButtonElement)
      this._trigger.disabled = !src;
  }
}
customElements.define("artifact-photo", ArtifactPhoto);
