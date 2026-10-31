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
  }

  connectedCallback() {
    this.innerHTML = `<dialog class="photo-lightbox" aria-label="${escapeAttr(t("lightbox.dialog.aria"))}">
      <figure class="photo-lightbox__figure">
        <div class="photo-lightbox__image-wrap">
          <img class="photo-lightbox__image" alt="" />
          <button class="photo-lightbox__close" type="button" aria-label="${escapeAttr(t("lightbox.close.aria"))}"><wa-icon name="xmark" aria-hidden="true"></wa-icon></button>
        </div>
        <figcaption class="photo-lightbox__caption"></figcaption>
      </figure>
    </dialog>`;
    this._dialog?.addEventListener("click", (event) => {
      if (event.target === this._dialog) this.close();
    });
    this._dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this._dialog?.addEventListener("close", () => this._restoreFocus());
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
    this.querySelector("img")?.removeAttribute("src");
    this._release?.();
    this._release = null;
    this._dialog?.close();
  }

  disconnectedCallback() {
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
  const mediaKey = trigger
    .querySelector("capture-photo")
    ?.getAttribute("data-media-key");
  const isCurrent = () => {
    if (!host.isConnected || !screen?.isConnected || !host.contains(screen))
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
  if (!isCurrent()) return;
  let image = trigger.querySelector("img");
  if (!(image instanceof HTMLImageElement)) return;
  const capture =
    /** @type {import("./capture-photo.js").CapturePhoto | null} */ (
      trigger.querySelector("capture-photo")
    );
  if (capture) {
    await customElements.whenDefined("capture-photo");
    if (!isCurrent()) return;
  }
  const original = capture ? await capture.original().catch(() => null) : null;
  if (!isCurrent()) {
    original?.release();
    return;
  }
  image = trigger.querySelector("img");
  if (!(image instanceof HTMLImageElement)) {
    original?.release();
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
    return;
  }
  const existing = host.querySelector("photo-lightbox");
  const lightbox =
    existing instanceof PhotoLightbox
      ? existing
      : /** @type {PhotoLightbox} */ (document.createElement("photo-lightbox"));
  if (!lightbox.isConnected) {
    lightbox.setAttribute("site-address", host._site?.address || "");
    host.append(lightbox);
  }
  lightbox._release?.();
  lightbox._release = original?.release;
  lightbox.open({
    src,
    alt: image.alt,
    address: trigger.dataset.photoAddress || "",
    capturedAt: trigger.dataset.photoTime || "",
    hideLocation: trigger.hasAttribute("data-photo-no-location"),
    previewOnly:
      original && "previewOnly" in original ? original.previewOnly : false,
    trigger,
  });
}

export { PhotoLightbox };
