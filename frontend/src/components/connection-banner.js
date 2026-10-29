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
    this.sync(connectionSnapshot());
    this.reserveSpace();
  }
  disconnectedCallback() {
    if (this.relocating) return;
    this.unsubscribe?.();
    clearTimeout(this.timer);
    this.modalObserver?.disconnect();
  }
  reserveSpace() {
    // Inert, invisible copies reserve their natural CSS height in page/toast
    // flow while the accessible, interactive banner stays in the top layer.
    for (const parent of [
      document.body,
      document.querySelector("app-toasts"),
    ]) {
      if (!parent) continue;
      let space = /** @type {HTMLElement | null} */ (
        parent.querySelector(":scope > .connection-banner-space")
      );
      if (!space) {
        space = document.createElement("div");
        space.className = "connection-banner-space";
        space.setAttribute("aria-hidden", "true");
        space.setAttribute("inert", "");
        parent.prepend(space);
      }
      space.hidden = !this.visible;
      const copy = /** @type {HTMLElement} */ (
        this.querySelector(".app-connection-banner").cloneNode(true)
      );
      copy.className = "connection-banner-copy";
      copy.removeAttribute("role");
      for (const node of copy.querySelectorAll(
        "[data-connection-copy], [data-connection-retry]",
      )) {
        node.removeAttribute("data-connection-copy");
        node.removeAttribute("data-connection-retry");
      }
      space.replaceChildren(copy);
    }
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
    this.reserveSpace();
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
          this.reserveSpace();
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
  const banner = /** @type {ConnectionBanner} */ (
    document.createElement("connection-banner")
  );
  document.body.prepend(banner);
  // A modal can replace its contents while the banner is portalled into it.
  // Restore the same shell-owned component instead of losing connectivity UI.
  new MutationObserver(() => {
    if (!banner.isConnected) document.body.prepend(banner);
    if (
      document.querySelector("app-toasts:not(:has(> .connection-banner-space))")
    )
      banner.reserveSpace();
  }).observe(document.body, { childList: true, subtree: true });
}
