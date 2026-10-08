/*
  site-switcher — the provider name button at the top of the home hub that
  opens a menu of the provider's sites.

  Presentational with one piece of local state (open). today-view owns the
  catalog and the actual switch: it creates
  one instance, pushes providerName / sites / currentSite / status before each
  of its renders, swaps the instance in for the <site-switcher> placeholder in
  the hero, and listens for:
    "switchsite"  detail { siteId }  — a site was chosen
    "retrysites"                     — retry loading the catalog
  Being re-attached after a host render keeps the menu's open state.
*/
import "./site-switcher.css";
import { siteSwitcher, switcherSites } from "./site-switcher.templates.js";

class SiteSwitcher extends HTMLElement {
  constructor() {
    super();
    /** @type {string} */
    this.providerName = "";
    /** @type {Array<{ siteId: string, name: string }>} */
    this.sites = [];
    /** @type {{ siteId: string, name: string }} */
    this.currentSite = { siteId: "", name: "" };
    /** @type {string} "idle" | "loading" | "loaded" | "error" */
    this.status = "idle";
    this._open = false;
    this._onDocumentClick = (event) => this._handleDocumentClick(event);
  }

  connectedCallback() {
    this.render();
    document.addEventListener("click", this._onDocumentClick);
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._onDocumentClick);
  }

  /** @returns {boolean} */
  get open() {
    return this._open;
  }

  /**
   * Open or close the menu and return focus to the trigger.
   * @param {boolean} open
   */
  setOpen(open) {
    this._open = open;
    this.render();
    /** @type {HTMLElement | null} */ (
      this.querySelector("#site-switcher-trigger")
    )?.focus();
  }

  /** Close without moving focus (outside click, or the host finished a switch). */
  close() {
    if (!this._open) return;
    this._open = false;
    this.render();
  }

  render() {
    this.innerHTML = siteSwitcher({
      providerName: this.providerName,
      sites: switcherSites(this.sites, this.currentSite),
      currentSiteId: this.currentSite.siteId,
      open: this._open,
      status: this.status,
    });
    this.querySelector("#site-switcher-trigger")?.addEventListener(
      "click",
      () => this.setOpen(!this._open),
    );
    this.querySelector(".home-site-switcher")?.addEventListener(
      "keydown",
      (event) => {
        if (/** @type {KeyboardEvent} */ (event).key !== "Escape") return;
        this.setOpen(false);
      },
    );
    this.querySelectorAll("[data-switch-site]").forEach((button) => {
      button.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("switchsite", {
            bubbles: true,
            detail: { siteId: button.getAttribute("data-switch-site") || "" },
          }),
        );
      });
    });
    this.querySelector("#site-catalog-retry")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("retrysites", { bubbles: true }));
    });
  }

  /**
   * A click anywhere outside the switcher closes it, except on a control
   * marked data-opens-site-switcher (the summary's "Change the site" button
   * opens the menu; its click must not immediately dismiss it).
   * @param {{ composedPath?: () => EventTarget[] }} event
   */
  _handleDocumentClick(event) {
    if (!this._open) return;
    const path = event.composedPath?.() || [];
    const inside = path.some(
      (node) =>
        node === this ||
        (node instanceof Element && node.matches("[data-opens-site-switcher]")),
    );
    if (!inside) this.close();
  }
}

customElements.define("site-switcher", SiteSwitcher);
