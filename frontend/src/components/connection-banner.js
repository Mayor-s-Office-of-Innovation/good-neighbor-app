import "./error-notice.css";
import { t } from "../i18n/i18n.js";
import {
  connectionSnapshot,
  onConnectionChange,
  retryConnection,
  startConnectionMonitoring,
} from "../services/connection-state.js";

class ConnectionBanner extends HTMLElement {
  connectedCallback() {
    if (this.relocating) return;
    startConnectionMonitoring();
    this.setAttribute("popover", "manual");
    this.innerHTML =
      '<div class="app-connection-banner" role="status" hidden><wa-icon name="circle-exclamation" aria-hidden="true"></wa-icon><span data-connection-copy></span><button type="button" data-connection-retry></button></div>';
    this.querySelector("button").textContent = t("notice.checkConnection");
    this.querySelector("button").addEventListener(
      "click",
      () => void retryConnection(),
    );
    this.unsubscribe = onConnectionChange((state) => this.sync(state));
    this.modalObserver = new MutationObserver(() => this.promote());
    this.modalObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["open"],
      subtree: true,
    });
    this.resizeObserver = new ResizeObserver((entries) => {
      document.documentElement.style.setProperty(
        "--connection-banner-height",
        `${this.visible ? entries[0]?.contentRect.height || 0 : 0}px`,
      );
    });
    this.resizeObserver.observe(this);
    this.sync(connectionSnapshot());
  }
  disconnectedCallback() {
    if (this.relocating) return;
    this.unsubscribe?.();
    clearTimeout(this.timer);
    this.modalObserver?.disconnect();
    this.resizeObserver?.disconnect();
    document.documentElement.style.removeProperty("--connection-banner-height");
  }
  promote() {
    // A top-layer popover outside an active modal is still inert. Keep the
    // banner inside that modal so its recovery control works with a keyboard.
    const dialogs = [...document.querySelectorAll("dialog:modal")];
    const parent = dialogs.at(-1) || document.body;
    if (this.parentElement !== parent) {
      this.relocating = true;
      parent.append(this);
      this.relocating = false;
    }
    if (!this.visible || typeof this.showPopover !== "function") return;
    if (this.matches(":popover-open")) this.hidePopover();
    this.showPopover();
  }
  sync({ disconnected }) {
    const panel = /** @type {HTMLElement} */ (
      this.querySelector(".app-connection-banner")
    );
    if (disconnected) {
      clearTimeout(this.timer);
      this.recoveredUntil = 0;
      this.visible = true;
      panel.hidden = false;
      panel.classList.remove("app-connection-banner--online");
      this.querySelector("wa-icon").setAttribute("name", "circle-exclamation");
      this.querySelector("[data-connection-copy]").textContent = t(
        "notice.disconnected",
      );
      this.querySelector("button").hidden = false;
      this.wasDisconnected = true;
      this.promote();
    } else if (this.wasDisconnected || this.recoveredUntil > Date.now()) {
      if (this.wasDisconnected) this.recoveredUntil = Date.now() + 5000;
      this.wasDisconnected = false;
      this.visible = true;
      panel.hidden = false;
      clearTimeout(this.timer);
      panel.classList.add("app-connection-banner--online");
      this.querySelector("wa-icon").setAttribute("name", "circle-check");
      this.querySelector("[data-connection-copy]").textContent =
        t("notice.online");
      this.querySelector("button").hidden = true;
      this.promote();
      this.timer = setTimeout(
        () => {
          this.visible = false;
          panel.hidden = true;
          if (this.matches(":popover-open")) this.hidePopover();
          document.documentElement.style.setProperty(
            "--connection-banner-height",
            "0px",
          );
        },
        Math.max(0, this.recoveredUntil - Date.now()),
      );
    }
  }
}
if (
  typeof customElements !== "undefined" &&
  !customElements.get("connection-banner")
)
  customElements.define("connection-banner", ConnectionBanner);
export function mountConnectionBanner() {
  if (
    typeof document === "undefined" ||
    !document.body ||
    document.querySelector("connection-banner")
  )
    return;
  const banner = document.createElement("connection-banner");
  document.body.prepend(banner);
  // A modal can replace its contents while the banner is portalled into it.
  // Restore the same shell-owned component instead of losing connectivity UI.
  new MutationObserver(() => {
    if (!banner.isConnected) document.body.prepend(banner);
  }).observe(document.body, { childList: true, subtree: true });
}
