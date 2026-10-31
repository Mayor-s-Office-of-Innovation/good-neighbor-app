import "./photo-lightbox.css";
import {
  formatPhotoDateTime,
  photoLocation,
} from "../domain/photo-lightbox.js";
import { openOverlayDialog } from "../dialog-history.js";
import { escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";

class PhotoLightbox extends HTMLElement {
  constructor() {
    super();
    /** @type {HTMLElement | null} */
    this._trigger = null;
    this._source = "";
    /** @type {(() => void) | null | undefined} */
    this._release = null;
    this._cancelPending = null;
  }

  connectedCallback() {
    this.innerHTML = `<dialog class="photo-lightbox" aria-label="${escapeAttr(t("lightbox.dialog.aria"))}">
      <figure class="photo-lightbox__figure">
        <div class="photo-lightbox__image-wrap">
          <img class="photo-lightbox__image" alt="" />
          <button class="photo-lightbox__close" type="button" aria-label="${escapeAttr(t("lightbox.close.aria"))}"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
        </div>
        <figcaption class="photo-lightbox__caption"></figcaption>
        <div class="photo-lightbox__recovery" hidden>
          <p role="status"></p>
          <button type="button" class="btn-secondary" data-photo-retry>${escapeAttr(t("common.retry"))}</button>
        </div>
      </figure>
    </dialog>`;
    this._dialog?.addEventListener("click", (event) => {
      if (event.target === this._dialog) this.close();
    });
    this._dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this._dialog?.addEventListener("close", () => {
      if (!this._dialog?.open) {
        this._cancelPending?.();
        this._restoreFocus();
      }
    });
    this.querySelector(".photo-lightbox__close")?.addEventListener(
      "click",
      () => this.close(),
    );
  }

  /** @returns {HTMLDialogElement | null} */
  get _dialog() {
    return this.querySelector("dialog");
  }

  /** @param {{ src: string, alt?: string, address?: string, capturedAt?: string, trigger?: HTMLElement, hideLocation?: boolean, previewOnly?: boolean }} photo */
  open(photo) {
    if (!photo.src || !this._dialog) return;
    const image = this.querySelector(".photo-lightbox__image");
    const caption = /** @type {HTMLElement | null} */ (
      this.querySelector(".photo-lightbox__caption")
    );
    if (!(image instanceof HTMLImageElement) || !caption) return;
    this._trigger = photo.trigger || null;
    this._source = photo.src;
    image.src = photo.src;
    image.alt = photo.alt || t("lightbox.image.alt");
    const address = photo.hideLocation
      ? ""
      : photoLocation(
          photo.address || "",
          this.getAttribute("site-address") || "",
        );
    const timestamp = photo.capturedAt
      ? formatPhotoDateTime(photo.capturedAt)
      : "";
    caption.textContent = [
      address,
      timestamp,
      photo.previewOnly ? t("lightbox.previewOnly") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    caption.hidden = !caption.textContent;
    openOverlayDialog(this._dialog, "photo-lightbox");
    /** @type {HTMLElement | null} */ (
      this.querySelector(".photo-lightbox__close")
    )?.focus();
  }

  close() {
    this._cancelPending?.();
    this.querySelector("img")?.removeAttribute("src");
    this._release?.();
    this._release = null;
    this._dialog?.close();
  }

  disconnectedCallback() {
    this._cancelPending?.();
    this.querySelector("img")?.removeAttribute("src");
    this._release?.();
    this._release = null;
    this._trigger = null;
    this._source = "";
  }

  _restoreFocus() {
    this.querySelector("img")?.removeAttribute("src");
    this._release?.();
    this._release = null;
    const trigger = this._trigger?.isConnected
      ? this._trigger
      : [...document.querySelectorAll("[data-photo-lightbox]")].find(
          (candidate) => {
            const image = candidate.querySelector("img");
            return (
              (candidate.getAttribute("data-full-src") ||
                (image instanceof HTMLImageElement
                  ? image.currentSrc || image.src
                  : "")) === this._source
            );
          },
        );
    if (trigger instanceof HTMLElement) trigger.focus();
    this._trigger = null;
    this._source = "";
    this.dispatchEvent(
      new CustomEvent("photolightboxclosed", { bubbles: true }),
    );
  }
}

customElements.define("photo-lightbox", PhotoLightbox);

/**
 * Create the singleton lazily and open the selected thumbnail.
 * @param {HTMLElement & { _site?: { address?: string } }} host
 * @param {HTMLElement} trigger
 * @param {Element | null} [screen] Screen that owned the trigger when clicked.
 */
export async function openPhotoLightbox(host, trigger, screen = trigger) {
  if (!host.isConnected || !screen?.isConnected || !host.contains(screen))
    return;
  const existing = host.querySelector("photo-lightbox");
  const lightbox =
    existing instanceof PhotoLightbox
      ? existing
      : /** @type {PhotoLightbox} */ (document.createElement("photo-lightbox"));
  if (!lightbox.isConnected) {
    lightbox.setAttribute("site-address", host._site?.address || "");
    host.append(lightbox);
  }
  lightbox._cancelPending?.();
  const controller = new AbortController();
  const { signal } = controller;
  let imageTimer;
  const observer = new MutationObserver(() => {
    if (!isCurrent()) lightbox.close();
  });
  const cancel = () => {
    controller.abort();
    clearTimeout(imageTimer);
    observer.disconnect();
    if (lightbox._cancelPending === cancel) {
      lightbox._cancelPending = null;
      const image = lightbox.querySelector("img");
      image.onerror = null;
      image.onload = null;
      if (!image.complete) image.removeAttribute("src");
      const retry = /** @type {HTMLButtonElement} */ (
        lightbox.querySelector("[data-photo-retry]")
      );
      retry.onclick = null;
    }
  };
  lightbox._cancelPending = cancel;
  const recovery = /** @type {HTMLElement} */ (
    lightbox.querySelector(".photo-lightbox__recovery")
  );
  recovery.hidden = true;
  const viewerImage = /** @type {HTMLImageElement} */ (
    lightbox.querySelector("img")
  );
  viewerImage.onerror = null;
  viewerImage.onload = null;
  viewerImage.hidden = false;
  const mediaKey = trigger
    .querySelector("capture-photo")
    ?.getAttribute("data-media-key");
  const isCurrent = () => {
    if (
      signal.aborted ||
      !host.isConnected ||
      !screen?.isConnected ||
      !host.contains(screen)
    )
      return false;
    if (trigger.isConnected && screen.contains(trigger)) return true;
    // A render may replace the button while keeping the same photo. Only a
    // live replacement with the same durable identity can finish this request.
    const replacement =
      mediaKey &&
      [...screen.querySelectorAll("capture-photo")]
        .find((photo) => photo.getAttribute("data-media-key") === mediaKey)
        ?.closest("[data-photo-lightbox]");
    if (!(replacement instanceof HTMLElement) || !screen.contains(replacement))
      return false;
    trigger = replacement;
    return true;
  };
  if (!isCurrent()) {
    cancel();
    return;
  }
  observer.observe(host, { childList: true, subtree: true });
  let image = trigger.querySelector("img");
  if (!(image instanceof HTMLImageElement)) {
    cancel();
    return;
  }
  const capture =
    /** @type {import("./capture-photo.js").CapturePhoto | null} */ (
      trigger.querySelector("capture-photo")
    );
  if (capture) {
    await customElements.whenDefined("capture-photo");
    if (!isCurrent()) return;
  }
  const original = capture
    ? await capture.original({ signal }).catch(() => null)
    : null;
  if (!isCurrent()) {
    original?.release();
    return;
  }
  image = trigger.querySelector("img");
  if (!(image instanceof HTMLImageElement)) {
    original?.release();
    cancel();
    return;
  }
  const src =
    original?.src ||
    trigger.dataset.fullSrc ||
    image.currentSrc ||
    image.getAttribute("src");
  if (!src) {
    if (capture) {
      const { showToast } = await import("../state/toasts.js");
      if (!isCurrent()) return;
      showToast({
        title: t("card.evidence.unavailable"),
        message: "",
        tone: "warning",
      });
    }
    cancel();
    return;
  }
  lightbox._release?.();
  lightbox._release = original?.release;
  const photo = {
    src,
    alt: image.alt,
    address: trigger.dataset.photoAddress || "",
    capturedAt: trigger.dataset.photoTime || "",
    hideLocation: trigger.hasAttribute("data-photo-no-location"),
    previewOnly: original
      ? Boolean("previewOnly" in original && original.previewOnly)
      : Boolean(capture),
    trigger,
  };
  const retry = /** @type {HTMLButtonElement} */ (
    recovery.querySelector("button")
  );
  retry.onclick = () => {
    if (isCurrent()) void openPhotoLightbox(host, trigger, screen);
  };
  if (photo.previewOnly) {
    recovery.hidden = false;
    recovery.querySelector("p").textContent = t("lightbox.downloadFailed");
  }
  let fallingBack = false;
  const failed = async () => {
    clearTimeout(imageTimer);
    if (!isCurrent()) return;
    if (fallingBack) {
      viewerImage.hidden = true;
      viewerImage.removeAttribute("src");
      lightbox._release?.();
      lightbox._release = null;
      return;
    }
    fallingBack = true;
    let preview = capture
      ? await capture.original({ signal, previewOnly: true }).catch(() => null)
      : null;
    if (!isCurrent()) {
      preview?.release();
      return;
    }
    const thumbnail = trigger.querySelector("img");
    const fallback =
      preview?.src ||
      (thumbnail instanceof HTMLImageElement
        ? thumbnail.currentSrc || thumbnail.getAttribute("src")
        : "");
    recovery.hidden = false;
    recovery.querySelector("p").textContent = t("lightbox.downloadFailed");
    lightbox._release?.();
    lightbox._release = preview?.release;
    if (fallback && fallback !== src) {
      lightbox.open({ ...photo, src: fallback, previewOnly: true });
    } else {
      viewerImage.hidden = true;
      viewerImage.removeAttribute("src");
    }
  };
  viewerImage.onerror = () => void failed();
  viewerImage.onload = () => clearTimeout(imageTimer);
  lightbox.open(photo);
  imageTimer = setTimeout(() => void failed(), 30000);
}

export { PhotoLightbox };
